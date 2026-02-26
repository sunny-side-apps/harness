# Design Audit: Master Improvement Plan
_Audit date: 2026-02-26_

Three specialized agents (Lead Architect, Security Engineer, Systems Integrator) reviewed ARCHITECTURE.md, DSL.md, CLASSIFICATION.md, SECURITY.md, and README.md. This document converges their findings into a single prioritized improvement plan.

---

## CRITICAL OMISSIONS

### CO-1 — Data model missing `source` and `auto_expire` fields _(CRITICAL)_
DSL.md references `source: "approval"` and `autoExpire: true` when storing approval-generated policies, but neither field exists in ARCHITECTURE.md's `policies` table.

**Fix — Add to policies table:**
```sql
policies (
  ...
  source       text default 'manual',   -- 'manual' | 'approval'
  auto_expire  boolean default false,   -- true for approval-generated policies
)
```

---

### CO-2 — Application sidecar storage is undefined _(CRITICAL)_
DSL.md defines two categories of approval responses stored in the "application sidecar" — `allow once` (one-time token) and `allow` (session-scoped grant). Neither has a documented storage mechanism. The data model has no table for these.

**Fix — Define a `session_grants` table:**
```sql
session_grants (
  id          uuid primary key,
  agent_id    uuid references agents,
  action      text,                        -- e.g. gmail:messages:archive
  grant_type  text,                        -- 'once' | 'session'
  consumed    boolean default false,       -- for 'once' grants
  expires_at  timestamptz,                 -- null for 'session' grants
  created_at  timestamptz,
  approval_id uuid                         -- links back to audit_log
)
```
Session-scoped grants expire when the MCP session ends (tracked via session_id in the agents table or an active_sessions table). One-time grants are marked `consumed = true` after first use.

---

### CO-3 — MCP server authentication protocol unspecified _(CRITICAL)_
ARCHITECTURE.md states agents use `p_{key}` as their identifier, but never specifies how the key is transmitted to the MCP server. Currently it is in the URL path, which exposes it in every server log, reverse proxy log, and CDN access log.

**Fix — Move agent key to Authorization header:**
```
POST https://mcp.savemyass.com/
Authorization: Bearer p_dGVhbS1vcGVuY2xhdw==
Content-Type: application/json
```
The URL becomes a single shared endpoint. The key is never in the path, query string, or request body — only in the Authorization header, which is excluded from standard access log configurations.

---

### CO-4 — Clerk token failure handling unspecified _(CRITICAL)_
Every Gmail operation depends on fetching the user's OAuth token from Clerk. No failure handling is documented for: token expired, Clerk unavailable, token revoked, network timeout.

**Fix:**
- Fetch token fresh on every request — never cache
- If token is expired: return `401 TokenExpired` to agent; do not retry silently
- If Clerk is unavailable: circuit breaker → fail-closed (return `503 UpstreamUnavailable`)
- If token is revoked by user: Clerk webhook triggers immediate agent session termination

---

### CO-5 — Cedar policy engine failure mode unspecified _(CRITICAL)_
If Cedar evaluation throws (malformed policy, version mismatch, corrupted policy set), no behavior is defined. This is the hot path for every request.

**Fix — Fail closed:**
- Cedar evaluation error → deny the request, log the error with full context
- Corrupted policy detected on load → keep previous valid policy set in memory (atomic swap only on successful load)
- Policy set unavailable (PostgreSQL down) → deny all requests, alert on-call

---

### CO-6 — Session lifecycle for `for session` grants unspecified _(CRITICAL)_
The MCP server is stateless. But `for session` grants must expire when the session ends. These two facts are in direct conflict — no resolution is documented.

**Fix — Define session via agent connection tracking:**
```sql
active_sessions (
  id          uuid primary key,
  agent_id    uuid references agents,
  started_at  timestamptz,
  last_seen   timestamptz,
  ended_at    timestamptz
)
```
MCP server creates a session on first connection and sends a `session_id` header on every response. Session-scoped grants are tied to `session_id`. A background sweep expires sessions with `last_seen > 30m` and cascades expiry to session grants.

---

### CO-7 — Pagination semantics broken by post-fetch filtering _(CRITICAL)_
The design fetches all Gmail results then strips unauthorized ones. This breaks pagination: if Gmail returns 50 emails and 30 are filtered, the agent receives 20 results but cannot tell if there are more pages, because the next page cursor was for the full 50.

**Fix — Two strategies:**
1. **Pre-filter via Gmail search optimization** (preferred): append policy conditions as Gmail search operators where possible (e.g., `from:*@team.com`, `label:sma/class/work`). Reduces the post-fetch filtering burden.
2. **Over-fetch and re-paginate**: when building a page of N results, fetch up to 3× N from Gmail and filter down, issuing additional fetches if the filtered count falls below N. Cap at 3 rounds to prevent runaway loops.
Document the limitation explicitly: agents requesting `limit=50` may receive fewer results per page when policies apply.

---

### CO-8 — Approval timeout and state not defined _(HIGH)_
When a high-risk action is intercepted and an approval request is sent, no timeout, expiry, or retry behavior is documented for the pending state.

**Fix:**
- Pending approvals expire after 10 minutes by default (configurable per agent)
- On expiry: draft is deleted, agent receives `ApprovalTimeout` error
- Approval state is stored in `pending_approvals` table:
```sql
pending_approvals (
  id           uuid primary key,
  agent_id     uuid references agents,
  action       text,
  resource_id  text,
  draft_id     text,          -- Gmail draft ID if applicable
  channel      text,          -- 'slack' | 'telegram'
  expires_at   timestamptz,
  resolved_at  timestamptz,
  response     text           -- 'allow_once' | 'allow' | 'allow_for' | 'deny'
)
```

---

### CO-9 — MCP tool JSON schemas not defined _(HIGH)_
Six MCP tools are listed in ARCHITECTURE.md but have no input/output schema. Agents cannot validate requests, and the server cannot enforce input constraints.

**Fix — Define schemas for all tools:**
```typescript
// search_emails
input:  { query: string, limit?: number (1-100), pageToken?: string }
output: { messages: GmailMessage[], nextPageToken?: string, filteredCount: number }

// read_email
input:  { id: string }
output: { message: GmailMessage } | { error: 'NotFound' | 'PolicyDenied' }

// draft_email
input:  { to: string[], subject: string, body: string, cc?: string[], replyTo?: string }
output: { draftId: string, status: 'created' | 'pending_approval' }

// archive_email / trash_email
input:  { id: string }
output: { status: 'executed' | 'pending_approval' } | { error: 'PolicyDenied' }

// list_labels
output: { labels: string[] }  -- only labels present on accessible emails
```

---

### CO-10 — Classification batch job not idempotent _(HIGH)_
If the onboarding batch job crashes halfway, re-running it may re-classify already-labeled emails or skip emails. No checkpoint or idempotency mechanism is defined.

**Fix:**
- Track progress in PostgreSQL:
```sql
classification_jobs (
  id              uuid primary key,
  user_id         uuid references users,
  status          text,       -- 'running' | 'completed' | 'failed'
  last_page_token text,       -- Gmail pagination cursor for resume
  processed_count integer,
  total_estimate  integer,
  started_at      timestamptz,
  completed_at    timestamptz
)
```
- On crash: resume from `last_page_token`, skip already-labeled messages (`sma/class/*` label already present → skip)
- LLM timeout: classify as `sma/class/unknown`, retry in background

---

## INCONSISTENCY LOG

### IL-1 — SECURITY.md approval table missing implementation details
DSL.md's approval response table includes a detailed "Implementation" column (sidecar vs Cedar). SECURITY.md has the same table but without implementation details, creating an incomplete picture for readers of SECURITY.md alone.

**Fix:** Add a reference in SECURITY.md: _"For implementation details of how each response is stored, see DSL.md § Human-in-the-Loop Approval."_

---

### IL-2 — README.md lists cross-service flow isolation as a primary goal
README.md lists "Cross-service flow isolation" under Core Goals (Trust and safety goals), but ARCHITECTURE.md marks it as Coming Soon (post-MVP). Users reading only the README will expect this feature to exist at launch.

**Fix:** In README.md, move cross-service flow isolation from "Trust and safety goals" to a "Coming soon" subsection, or add a note: _(post-MVP)_.

---

### IL-3 — Delegation chains not marked as post-MVP in DSL.md's main flow
ARCHITECTURE.md's MVP scope explicitly excludes delegation chains. DSL.md has a `delegate` syntax section at the top level of the DSL specification, only labeled "Coming Soon" at the very bottom. A reader skimming the DSL spec would assume it is supported.

**Fix:** Add a _(Coming soon — not supported in MVP)_ note directly in the `delegate` syntax definition.

---

## SECURITY ATTACK VECTORS

### SAV-1 — Agent key exposed in URL path _(CRITICAL)_
Agent keys in the URL path appear in server logs, reverse proxy logs, CDN logs, and browser history.

**Mitigation:** Move key to Authorization header (see CO-3 above). Configure Fly.io proxy to exclude Authorization headers from access logs.

---

### SAV-2 — API server could cache Gmail OAuth tokens _(CRITICAL)_
The design has no enforcement preventing the API server from caching Clerk-issued Gmail tokens in memory. A compromised server process could extract and exfiltrate all user tokens.

**Mitigation:**
- Document token non-caching as an architectural invariant
- Fetch token from Clerk, use it immediately in a local scope, allow GC
- Use short-lived Clerk tokens (≤10 min TTL) to limit exposure window
- Restrict API server egress to Clerk and Gmail endpoints only (Fly.io firewall rules)

---

### SAV-3 — Implicit MCP→API server trust _(CRITICAL)_
No authentication is documented between the MCP server and the API server. A compromised or spoofed MCP server could make arbitrary API calls.

**Mitigation:** Add service-to-service authentication:
- MCP server authenticates to API server via a shared secret in the `Authorization` header (rotated regularly)
- API server validates the secret and rejects requests that don't include it
- Document this in ARCHITECTURE.md § Deployment

---

### SAV-4 — Classification label poisoning _(HIGH)_
An agent with label-write access could reclassify emails by removing `sma/class/auth` and adding `sma/class/work`, bypassing deny policies.

**Mitigation:**
- Add an implicit deny for all agents on `sma/class/*` and `sma/*` label modification:
  ```
  deny * to [update, delete] on gmail.labels where { name startsWith "sma/" }
  ```
- Enforce this as a hardcoded system-level deny that cannot be overridden by user policies

---

### SAV-5 — Audit log tampering _(HIGH)_
Audit logs are in PostgreSQL. A compromised agent key grants API access — if the API server can DELETE from audit_log, an attacker could erase evidence.

**Mitigation:**
- API server database role has INSERT + SELECT only on audit_log — never DELETE or UPDATE
- Ship audit logs to external append-only storage immediately (Fly.io → external log aggregation)
- Add HMAC signature per audit entry so tampering is detectable even if rows are modified

---

### SAV-6 — Policy injection via LLM/DSL compiler _(HIGH)_
The NL→DSL translation uses an LLM. Malicious user input could cause the LLM to output Cedar keywords (`permit`, `forbid`, `principal`) that, if not properly sanitized, break out of the DSL layer.

**Mitigation:**
- Use a formal grammar parser for DSL (not string matching)
- DSL parser runs before Cedar emission — invalid tokens are rejected at the Parse phase
- Cedar is emitted via a programmatic builder API (not string concatenation), making injection structurally impossible
- Add a post-LLM validation step: reject any LLM output containing Cedar keywords outside of quoted strings

---

### SAV-7 — Result count/timing oracle _(HIGH)_
Post-fetch filtering leaks information: request latency correlates with the number of emails fetched (including denied ones). An agent can infer the existence of hidden emails via timing.

**Mitigation:**
- Prefer server-side query optimization (step 5 in request flow) to minimize over-fetching
- Do not return `total_count` or metadata for filtered results
- Consider jitter on response time (adds noise, reduces timing signal)

---

### SAV-8 — HIL approval flood (denial of attention) _(MEDIUM)_
An agent can trigger unlimited approval requests, flooding the user's Slack/Telegram.

**Mitigation:**
- Rate limit: max 5 pending approvals per agent at any time
- Additional approval requests while 5 are pending → denied with `ApprovalQueueFull` error
- Batch similar approval requests: "Agent X is requesting 10 archive operations. Approve all?"

---

### SAV-9 — Gmail Watch side-channel _(MEDIUM)_
If an agent can register a Gmail push notification subscription, it may observe notification events for emails it cannot read (inferring their existence or arrival time).

**Mitigation:**
- Gate `gmail:watch` through the policy engine — explicit `allow` required
- Push notifications delivered to agents are pre-filtered: agent only receives notifications for emails it can access
- Classify watch as a **high** risk tier requiring explicit grant

---

## REFINED DESIGN PROPOSAL

The core architecture is sound. The refinements below make it production-ready.

### 1. Updated Data Model

```sql
-- Add to policies table
source       text default 'manual',   -- 'manual' | 'approval'
auto_expire  boolean default false,

-- New: session grants (for 'allow once' and 'allow' approval responses)
session_grants (
  id          uuid primary key,
  agent_id    uuid references agents,
  session_id  uuid references active_sessions,
  action      text,
  grant_type  text,                    -- 'once' | 'session'
  consumed    boolean default false,
  created_at  timestamptz
)

-- New: active MCP sessions
active_sessions (
  id          uuid primary key,
  agent_id    uuid references agents,
  started_at  timestamptz,
  last_seen   timestamptz,
  ended_at    timestamptz
)

-- New: pending approvals
pending_approvals (
  id           uuid primary key,
  agent_id     uuid references agents,
  action       text,
  resource_id  text,
  draft_id     text,
  channel      text,
  expires_at   timestamptz,
  resolved_at  timestamptz,
  response     text
)

-- New: classification job tracking
classification_jobs (
  id              uuid primary key,
  user_id         uuid references users,
  status          text,
  last_page_token text,
  processed_count integer,
  started_at      timestamptz,
  completed_at    timestamptz
)
```

### 2. Updated Request Flow (MCP)

```
Agent → POST https://mcp.savemyass.com/
        Authorization: Bearer p_{key}

  1.  MCP server extracts key from Authorization header
  2.  MCP server calls API server: POST /internal/mcp-request
      Authorization: Bearer {mcp-service-secret}
      Body: { key, tool, args }
  3.  API server validates mcp-service-secret
  4.  API server resolves p_{key} → (userId, agentId) — hash lookup
  5.  Check agent not revoked
  6.  Load active Cedar policies + session_grants from PostgreSQL
  7.  PolicyEngine.evaluate(request) → permit | deny | pending_approval
      a. Cedar evaluation (conditions, time windows)
      b. Session grant check (one-time, session-scoped)
      c. Sidecar check (requires_approval)
  8.  If deny → return immediately, write audit entry
  9.  If pending_approval → create pending_approval row, send HIL notification, return
  10. Fetch fresh Gmail OAuth token from Clerk (no cache)
  11. [Optional] Append policy conditions to Gmail search filter
  12. Forward to Gmail API
  13. Post-fetch filter: extract attributes, Cedar evaluation per result, strip denied
  14. Return filtered results
  15. Write audit entry (INSERT only)
```

### 3. Updated Security Invariants

These are hardcoded system-level rules that cannot be overridden by user policies:

```
# Agents cannot modify classification labels
deny * to [update, delete] on gmail.labels where { name startsWith "sma/" }

# Agents cannot access policy management endpoints
# (enforced at API layer by authentication context, not Cedar)

# Gmail OAuth tokens are never cached in application memory

# Audit log is append-only (enforced at database layer)

# Agent keys are transmitted only in Authorization header, never in URL
```

### 4. Failure Mode Table

| Component | Failure | Behavior |
|---|---|---|
| PostgreSQL unavailable | Policy load fails | Fail closed — deny all requests |
| Clerk unavailable | Token fetch fails | Fail closed — return 503 to agent |
| Cedar evaluation throws | Runtime error | Fail closed — deny request, alert |
| Gmail API unavailable | Upstream error | Return 503 to agent, do not retry automatically |
| Gmail API rate limit | 429 from Gmail | Return 429 to agent with Retry-After |
| Approval channel unavailable | Notification fails | Retry 3× over 5 minutes, then block with error |
| Classification LLM unavailable | Classification fails | Mark message as `sma/class/unknown`, retry in background |

### 5. Key Changes to Each Document

**ARCHITECTURE.md:**
- Move agent key from URL path to Authorization header
- Add `source`, `auto_expire` to policies table
- Add `session_grants`, `active_sessions`, `pending_approvals`, `classification_jobs` tables
- Add MCP→API service authentication
- Add failure mode table
- Add pagination over-fetch strategy
- Define MCP tool JSON schemas

**DSL.md:**
- Add note to `delegate` syntax: _(Coming soon — not in MVP)_

**SECURITY.md:**
- Add cross-reference to DSL.md for approval implementation details
- Add system-level hardcoded deny rules (label protection, audit immutability)
- Add token non-caching invariant

**README.md:**
- Move cross-service flow isolation from Core Goals to Coming Soon
