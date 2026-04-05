# Architecture & Implementation

## System Overview

Save My Ass is a cloud-hosted policy enforcement layer that gives AI agents fine-grained, auditable access to Gmail — going beyond what OAuth scopes can express.

**The core problem:** OAuth grants are too coarse. `gmail.modify` gives an agent full inbox access forever. Save My Ass lets users say "openclaw can read emails from my team, for 2 hours, nothing else."

**How agents connect:** Save My Ass exposes an **MCP server** at `https://mcp.savemyass.com`. Each registered agent gets a unique key. The agent authenticates by passing the key in the `Authorization: Bearer {key}` header. Policy enforcement happens server-side on every tool call.

**How agents discover it:** Save My Ass ships as an **AgentSkill** — a SKILL.md distributed via agentskills.io that tells any compatible agent (Claude Code, OpenClaw, Cursor, OpenHands, etc.) how to connect to the MCP server. The AgentSkill is the distribution mechanism; the MCP server is the enforcement point.

**How users manage it:** 1. Via a dedicated web interface with standard auth powered by Clerk.com (for most users). 2. Via a CLI tool using an API key (issued on the web interface) - that is for tech-savvy users who want to provide the CLI to their personal agent of choice (e.g. Claude) and manage the service through that.

**Stack:** TypeScript + Bun + Hono, PostgreSQL, Fly.io, Clerk (auth + Google OAuth).

---

## Components

### 1. API Server (`api.savemyass.com`)

The core service. Contains all business logic: policy enforcement, Gmail API calls, audit logging, agent key resolution, and policy compilation. Every other component is a client of the API server.

### 2. MCP Server (`mcp.savemyass.com`)

A thin MCP protocol adapter. Translates MCP tool calls into API server calls. No direct database access, no business logic. Stateless and horizontally scalable.

Authenticates agents via `Authorization: Bearer sma_{key}` header on every request. Forwards requests to the API server using a shared service secret (`Authorization: Bearer {mcp-service-secret}`). The API server validates the service secret before processing any request — requests without it are rejected regardless of agent key.

**MCP tools exposed:**

| Tool            | Input                                                                              | Output                                                         |
| --------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `search_emails` | `{ query: string, limit?: number (1–100), pageToken?: string }`                    | `{ messages: GmailMessage[], nextPageToken?: string }`         |
| `read_email`    | `{ id: string }`                                                                   | `{ message: GmailMessage }`                                    |
| `draft_email`   | `{ to: string[], subject: string, body: string, cc?: string[], replyTo?: string }` | `{ draftId: string, status: 'created' \| 'pending_approval' }` |
| `archive_email` | `{ id: string }`                                                                   | `{ status: 'executed' \| 'pending_approval' }`                 |
| `trash_email`   | `{ id: string }`                                                                   | `{ status: 'executed' \| 'pending_approval' }`                 |
| `list_labels`   | —                                                                                  | `{ labels: string[] }` — only labels on accessible emails      |
| `triage_inbox`  | —                                                                                  | `{ summary: string }` (Show unread inbox summary (sender, subject, date))

### 3. Workflow Engine

All background jobs run through **pg-workflows** — a PostgreSQL-backed workflow orchestration library that provides durable execution, exactly-once step semantics, automatic retries with exponential backoff, and built-in checkpointing. No external queue infrastructure required — PostgreSQL is the only dependency.

**Workflows:**

- `classification-onboarding` — batch classifies the user's inbox on signup; checkpoints after each page so it resumes safely after crashes
- `classification-incremental` — triggered per new email via Gmail push notification
- `hil-approval` — pauses on `step.waitFor('approval-response')` until the user responds via Slack/Telegram, then executes or cancels the action; times out after 10 minutes
- `expiry-sweep` — runs every minute to disable expired policies and clean up stale sessions

### 4. Policy Engine

Cedar-based rule evaluation embedded in the API server. Loaded per agent request from PostgreSQL. Default-deny: if no rule matches, the request is blocked.

### 4. Compiler

Transforms user intent into Cedar policies. Runs on policy creation via `sma policy add`. Pipeline:

```
Natural language
  → NL Translator (LLM) → AgentGate DSL
  → shown to user for confirmation
  → Parse → Resolve → Type-check → Delegation ceiling → Conflict detection
  → Emit Cedar policies
  → Store in PostgreSQL
```

If any phase fails, the policy is rejected and the active set is untouched.

### 5. Dashboard (`app.savemyass.com`)

React app. Read-only view of active policies, registered agents, and audit log. No policy management — that is the CLI's job.

### 6. CLI (`sma`)

Dual-purpose tool: Full CLI Gmail client for humans and agents, with every command routed through the policy engine via the API server. The UX is identical to https://github.com/steipete/gogcli but with a safety net.

**Email operations:**

```bash
sma gmail search "is:unread newer_than:7d"
sma gmail read <id>
sma gmail send --to alice@co.com --subject "..." --body "..."
sma gmail draft list
sma gmail draft create / edit / send <id>
sma gmail archive <id>
sma gmail trash <id>
sma gmail labels list / create / update
sma gmail filters list / create
sma gmail watch                          # server-push via Pub/Sub
```

**Other Workspace services (post-MVP):**

```bash
sma calendar events / create / rsvp
sma drive ls / download / upload
sma contacts list / search
sma tasks list / complete
```

**Policy and agent management:**

```bash
sma policy add "let openclaw read team emails for 2h"
sma policy list / show / disable / remove
sma agent register / list / revoke
sma grant / revoke / grants
sma audit / audit show <id>
```

**For agents (via AgentSkill):** `sma` accepts `--agent-key sma_{key}` to identify the calling agent. Every command is evaluated against that agent's policies before execution.

### 7. AgentSkill

A SKILL.md file distributed via agentskills.io. Tells compatible agents (Claude Code, OpenClaw, Cursor, OpenHands, GitHub Copilot, etc.) how to connect to the MCP server or use `sma` commands. Discovery and onboarding mechanism — no runtime role.

---

## Request Flow

Agents connect via two paths: MCP for hosted and MCP-native agents, CLI for shell-capable agents.

### Read operations (MCP path)

```
Agent calls search_emails(query="from:team@company.com")
  Authorization: Bearer sma_{key}

  1.  MCP server extracts sma_{key} from Authorization header
  2.  MCP server calls API server:
        POST /internal/gmail/search
        Authorization: Bearer {mcp-service-secret}
        Body: { agentKey: sma_{key}, tool: "search_emails", args: {...} }
  3.  API server validates mcp-service-secret — rejects if missing/invalid
  4.  API server resolves sma_{key} hash → (userId, agentId)
  5.  Check agent is registered and not revoked
  6.  Load active Cedar policies + session grants from PostgreSQL
        Failure: PostgreSQL unavailable → fail closed (deny, return 503)
  7.  Policy engine early exit: is any no-action zone active for this agent/resource?
        Active no-action zone → deny immediately
      Then check: is any read policy active for this agent?
        No matching policy → deny immediately
  8.  [Optional] Append policy conditions to Gmail search query as filter optimization
  9.  Fetch fresh Gmail OAuth token from Clerk (never cached)
        Failure: Clerk unavailable → fail closed (deny, return 503)
        Failure: token revoked → deny, return 401
  10. Forward request to Gmail API
        Failure: Gmail unavailable → return 503, do not retry automatically
        Failure: Gmail 429 → return 429 with Retry-After to agent
  11. Gmail returns results (paginated)
  12. Extract attributes from each result (from, to, subject, labels, date)
  13. Policy engine evaluates each result — unauthorized items stripped
        Failure: Cedar throws → fail closed (deny entire response, log error)
  14. If filtered count < requested limit, fetch next page and repeat (max 3 rounds)
  15. Return filtered results to agent
  16. Write audit entry to PostgreSQL (INSERT only — append-only)
```

### Read operations (CLI/AgentSkill path)

```
Agent runs: sma gmail search "from:team@company.com" --agent-key sma_{key}
  1. sma calls API server: POST /gmail/search
     Authorization: Bearer sma_{key}
  2-16. Same enforcement pipeline as MCP path
```

Post-fetch filtering (step 13) is the primary enforcement point. Step 7 is a cheap early exit and also enforces no-action zones. Step 8 is an optional optimization. The agent never knows filtering happened — unauthorized emails are completely invisible.

**Pagination:** post-fetch filtering may reduce page sizes. The API server over-fetches up to 3 rounds to fill a page when results are filtered. Agents receive a `nextPageToken` only when more results exist in the filtered set — Gmail's total count is never exposed.

### Write operations (both paths)

```
Agent calls draft_email / sma gmail send
  1-4. Same resolution and policy check as read path
  5. If an active no-action zone matches, deny immediately
  6. Classify action risk tier:
       draft, archive, label  → medium  (auto-allow, notify user)
       send, reply            → high    (create Gmail draft, label pending-approval)
       trash, delete          → critical (block + send approval request via Slack/Telegram)
  7. Return result to agent
  8. Write audit entry to PostgreSQL
```

---

## Authentication & Agent Identity

### User authentication

Handled entirely by Clerk. Users sign up with Google — Clerk runs the OAuth flow and manages the Gmail access token. Save My Ass stores nothing OAuth-related. When the API server needs to call Gmail on behalf of a user, it fetches the token from Clerk at request time.

### Agent identity

Each registered agent gets a unique key (`p_{base64_random}`). The key is the full identifier — it encodes both the user and the agent. It is transmitted exclusively in the `Authorization` header — never in the URL path, query string, or request body.

```bash
sma agent register "openclaw"
# Returns the key: p_dGVhbS1vcGVuY2xhdw==
# MCP: set Authorization: Bearer p_dGVhbS1vcGVuY2xhdw== in agent config
# CLI: sma gmail search "..." --agent-key p_dGVhbS1vcGVuY2xhdw==
```

On every request, the API server hashes the key and looks it up in PostgreSQL. If the key does not exist, is revoked, or the account is inactive — deny immediately, before any policy evaluation.

**Key security:**

- Generated with `crypto.randomBytes(32)`, base64url-encoded
- Transmitted only in the `Authorization` header (excluded from standard access logs)
- Stored as a SHA-256 hash in PostgreSQL — the raw key is shown once at registration and never stored
- Revocation is immediate: `sma agent revoke "openclaw"` marks the key revoked in PostgreSQL; all subsequent requests are denied within one request cycle

**Gmail OAuth tokens:**

- Fetched fresh from Clerk on every request — never cached in application memory
- Used within the request scope only — eligible for garbage collection immediately after the Gmail API call completes
- Never written to logs, audit entries, or any persistent storage

Agent identity is bound to the key server-side. Agents cannot claim to be a different agent.

---

## Email Classification

On user onboarding, Save My Ass runs a classification job across the inbox and applies Gmail labels. These labels are the foundation for writing meaningful policies — they turn vague intent into enforceable rules.

### Classification taxonomy (`sma/class/...`)

| Label                    | Description                                         |
| ------------------------ | --------------------------------------------------- |
| `sma/class/auth`         | Password resets, login codes, 2FA, security alerts  |
| `sma/class/alert`        | System alerts, monitoring, error notifications      |
| `sma/class/notification` | App notifications, mentions, activity updates       |
| `sma/class/comment`      | Code review comments, document comments, PR reviews |
| `sma/class/subscription` | Subscription confirmations, renewal reminders       |
| `sma/class/marketing`    | Promotional emails, newsletters, offers             |
| `sma/class/receipt`      | Invoices, purchase confirmations, billing           |
| `sma/class/calendar`     | Meeting invites, calendar updates, RSVPs            |
| `sma/class/personal`     | Emails from friends and family                      |
| `sma/class/work`         | Emails from colleagues and work contacts            |
| `sma/class/finance`      | Bank statements, financial notifications            |
| `sma/class/shipping`     | Order tracking, delivery updates                    |

### How classification works

- **Deterministic rules first:** known sender patterns (`noreply@github.com` → comment), subject patterns, and domain lists handle the majority of emails cheaply
- **LLM fallback:** ambiguous emails that don't match deterministic rules are classified by an LLM
- **Labels written to Gmail directly:** Save My Ass stores no classification data internally — Gmail is the classification store
- **Onboarding batch job:** classifies the full existing inbox on signup
- **Incremental classification:** new emails are classified in real time via Gmail push notifications (`sma gmail watch`)

### Why this matters for policies

```
deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }
allow "openclaw" to [read] on gmail.messages where { labels contains "sma/class/work" }
allow "research-bot" to [read] on gmail.messages where { labels contains "sma/class/notification" }
```

---

## Policy Engine & Compiler

### The compiler

Transforms user intent into Cedar policies. Runs when a policy is created via `sma policy add`.

**Phases:**

1. **NL Translation** — LLM converts natural language to AgentGate DSL. Ambiguous input triggers clarifying questions. Result shown to user for confirmation before proceeding.
2. **Parse** — DSL source → AST
3. **Resolve** — Links references to known Gmail resource model (messages, operations, attributes). Unknown references are a compile-time error.
4. **Type-check** — Validates that conditions use operators valid for the attribute type
5. **Delegation ceiling** — Verifies the policy does not exceed the agent's delegated permissions
6. **Conflict detection** — Detects shadowed allows, redundant rules, and delegation violations. Errors block activation; warnings require acknowledgment.
7. **Emit Cedar** — Produces compiled Cedar policies stored in PostgreSQL

If any phase fails, the active policy set is untouched.

### The policy engine

Cedar-based evaluation embedded in the API server. Loaded per agent request. Default-deny: if no rule matches, the action is blocked. Policy set updates are atomic — in-flight requests finish with the old set, the next request uses the new one.

**Failure modes:**

- Cedar evaluation throws → fail closed: deny the request, log the full error with context, alert on-call
- Policy set fails to load from PostgreSQL → fail closed: deny all requests, serve 503
- Corrupted policy detected on load → keep the previous valid policy set in memory; do not swap until a new valid set is available

---

## Data Model

```sql
-- Users (mirrors Clerk)
users (
  id          uuid primary key,
  email       text not null,
  created_at  timestamptz
)

-- Registered agents
agents (
  id          uuid primary key,
  user_id     uuid references users,
  name        text not null,
  key_hash    text not null,      -- SHA-256 hash of sma_{key}
  key_prefix  text not null,      -- p_{first8} for display only
  created_at  timestamptz,
  revoked_at  timestamptz
)

-- Active MCP sessions (used for 'for session' grant tracking)
active_sessions (
  id          uuid primary key,
  agent_id    uuid references agents,
  started_at  timestamptz,
  last_seen   timestamptz,
  ended_at    timestamptz          -- null while active
)

-- Compiled policies
policies (
  id               uuid primary key,
  user_id          uuid references users,
  agent_id         uuid references agents,
  dsl              text,
  cedar            text,
  natural_language text,
  enabled          boolean default true,
  expires_at       timestamptz,
  created_at       timestamptz,
  version          integer,
  source           text default 'manual',  -- 'manual' | 'approval'
  auto_expire      boolean default false   -- true for approval-generated policies
)

-- Session grants (for 'allow once' and 'allow' HIL approval responses)
session_grants (
  id          uuid primary key,
  agent_id    uuid references agents,
  session_id  uuid references active_sessions,
  action      text,                        -- e.g. gmail:messages:archive
  grant_type  text,                        -- 'once' | 'session'
  consumed    boolean default false,       -- true after 'once' grant is used
  created_at  timestamptz
)

-- Audit log (append-only — no DELETE or UPDATE permitted on this table)
audit_log (
  id               uuid primary key,
  agent_id         uuid references agents,
  action           text,                   -- gmail:messages:read, etc.
  resource_type    text,                   -- GmailMessage
  resource_id      text,
  decision         text,                   -- permit, deny, pending_approval
  matched_policies uuid[],
  workflow_run_id  text,                   -- pg-workflows run ID if HIL approval triggered
  outcome          text,                   -- executed, blocked, pending_approval
  created_at       timestamptz
)
```

Background job state (classification jobs, HIL approval state, expiry sweeps) is managed by **pg-workflows** in its own `workflow_runs` table. No custom job tables are needed.

---

## Deployment

```
app.savemyass.com  (React dashboard)  ─┐
mcp.savemyass.com  (MCP adapter)      ─┼──→  api.savemyass.com  →  PostgreSQL
sma CLI                               ─┘            │
                                                     └──→  Gmail API (via Clerk token)
```

All services run on Fly.io. The API server contains all business logic — the MCP server and CLI are thin clients. Adding a new interface (REST, webhook, etc.) is a thin adapter on top of the same API.

**Service-to-service authentication:** The MCP server authenticates to the API server via a shared `mcp-service-secret` in the `Authorization` header of every internal request. The API server rejects any request not bearing this secret, regardless of agent key validity.

**CLI distribution:** `sma` is distributed as a standalone binary compiled with Bun. Users authenticate once:

```bash
sma auth login    # opens browser → Clerk → saves session token locally
```

**Scaling:** The MCP server and API server are stateless. Both scale horizontally on Fly.io. Policy sets are loaded from PostgreSQL per request.

**Failure modes:**

| Component failure              | Behavior                                                   |
| ------------------------------ | ---------------------------------------------------------- |
| PostgreSQL unavailable         | Fail closed — deny all requests, return 503                |
| Clerk unavailable              | Fail closed — deny all requests, return 503                |
| Clerk token revoked            | Deny request, return 401                                   |
| Cedar evaluation throws        | Fail closed — deny request, log error, alert               |
| Gmail API unavailable          | Return 503 to agent — do not retry automatically           |
| Gmail API rate limit (429)     | Return 429 with Retry-After to agent                       |
| Approval channel unavailable   | Retry 3× over 5 min — if all fail, block action with error |
| Classification LLM unavailable | Label as `sma/class/unknown`, retry in background          |

---

## Logging

All services (API server, MCP adapter, CLI, workflow workers) use **Pino** as the structured logger. Logs are emitted as JSON in production and are shaped for direct ingestion into Datadog.

### Logger baseline

- **Library:** `pino`
- **Development output:** `pino-pretty` for local readability only
- **Production output:** raw JSON only (no pretty transport)
- **Context propagation:** `@blueground/async-mdc` for mapped diagnostic context (MDC) across async boundaries

### Environment behavior

- **Development (`NODE_ENV=development`)**: enable `pino-pretty`
- **Test/CI**: keep machine-readable JSON output
- **Production**: keep JSON output and rely on Datadog pipelines/facets

### MDC and correlation strategy

Each request/workflow seeds MDC once and every log line automatically includes active context:

- `http.request_id` (or equivalent request ID)
- `agent_id`, `user_id`, `policy_id`, `workflow_run_id` when available
- `correlation_id` when tracing correlation is available

This removes manual context threading and keeps logs joinable across API, MCP, workflow, and approval flows.

### Standard log bindings (Datadog-first)

Default logger bindings and event fields should follow Datadog standard attributes as the canonical naming model.

Minimum common bindings:

- `service`, `env`, `version`, `host`
- `status` (mirrors log severity)
- `message`
- `trace_id` (when available)
- `http.request_id` for request correlation
- `duration` in **nanoseconds** for latency fields

Domain-specific fields should prefer Datadog standard names where applicable (`http.*`, `network.*`, `db.*`, `error.*`, `usr.*`, etc.) to minimize custom remapping in log pipelines.

---

## MVP Scope

**Included:**

- User signup via Clerk + Google OAuth
- Inbox classification on onboarding + incremental via push notifications
- Agent registration + key generation (`sma_{key}`)
- Policy management via `sma` CLI — natural language and DSL
- Policy compiler: NL → AgentGate DSL → Cedar
- Policy engine: Cedar-based default-deny evaluation
- Gmail operations via `sma` and MCP: search, read, draft, archive, trash
- Post-fetch result filtering per active policies
- Timeboxed access (`for 2h`, `during weekdays(9,17)`, `for session`)
- No-action zones (`noaction ...`) to block all email interaction during a user-defined timespan
- Draft-first model for send operations
- Just-in-time approval via Slack or Telegram for high and critical actions
- Audit log (PostgreSQL)
- AgentSkill (SKILL.md) for agent discovery
- Read-only React dashboard (policies, agents, audit log)

**Excluded from MVP:**

- Outlook / IMAP support
- Automatic send without approval
- Delegation chains (multi-agent orchestration)
- Other Workspace services (Calendar, Drive, Contacts)
- Multi-account support

**Coming soon:**

- **Cross-service flow rules** — when an agent reads sensitive data from one service, block it from leaking to another (e.g. reading medical emails taints the session and blocks posting to Slack or GitHub). Requires a second service integration to be meaningful.

---

## Project Structure

```
savemyass/
├── package.json
├── tsconfig.json
├── apps/
│   ├── api/                          # API server (Bun + Hono)
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── agents.ts         # Agent registration + key management
│   │       │   ├── policies.ts       # Policy CRUD
│   │       │   ├── gmail.ts          # Gmail operations (search, read, draft, etc.)
│   │       │   ├── grants.ts         # Timeboxed grants
│   │       │   └── audit.ts          # Audit log queries
│   │       ├── compiler/
│   │       │   ├── parser.ts         # DSL source → AST
│   │       │   ├── resolver.ts       # AST → Resolved AST
│   │       │   ├── typechecker.ts    # Validate condition types
│   │       │   ├── conflicts.ts      # Conflict and shadow detection
│   │       │   ├── emitter.ts        # Resolved AST → Cedar policies
│   │       │   └── errors.ts         # Rich error messages
│   │       ├── runtime/
│   │       │   ├── engine.ts         # Request evaluation — wraps policy engine
│   │       │   ├── policy-engine.ts  # Cedar init, load, atomic swap
│   │       │   ├── filter.ts         # Attribute extraction + post-fetch filtering
│   │       │   └── context.ts        # Build policy context (now, hourOfDay, etc.)
│   │       ├── classification/
│   │       │   ├── rules.ts          # Deterministic classification rules
│   │       │   ├── llm.ts            # LLM-based classification fallback
│   │       │   └── labels.ts         # Gmail label management
│   │       ├── nl/
│   │       │   ├── translator.ts     # NL → AgentGate DSL
│   │       │   ├── clarifier.ts      # Ambiguity detection
│   │       │   └── summary.ts        # DSL → human-readable summary
│   │       ├── timebox/
│   │       │   └── grants.ts         # Grant creation + parsing
│   │       ├── approval/
│   │       │   ├── broker.ts         # Approval notification dispatch
│   │       │   ├── slack.ts          # Slack integration
│   │       │   └── telegram.ts       # Telegram integration
│   │       ├── workflows/
│   │       │   ├── engine.ts         # WorkflowEngine init + pg-boss setup
│   │       │   ├── classification-onboarding.ts  # Batch inbox classification
│   │       │   ├── classification-incremental.ts # Per-email push classification
│   │       │   ├── hil-approval.ts               # HIL approval (step.waitFor)
│   │       │   └── expiry-sweep.ts               # Periodic policy + session expiry
│   │       └── db/
│   │           └── schema.ts         # PostgreSQL schema
│   ├── mcp/                          # MCP adapter (Bun + Hono)
│   │   └── src/
│   │       ├── server.ts             # MCP server entry point
│   │       └── tools.ts              # MCP tool definitions → API calls
│   └── dashboard/                    # Read-only dashboard (React)
├── packages/
│   └── skill/
│       └── SKILL.md                  # AgentSkill definition
└── bin/
     w└── main.ts                        # CLI entry point
```

### Key Dependencies

- `@cedar-policy/cedar-wasm` — policy evaluation runtime
- `@anthropic-ai/sdk` — LLM for NL → DSL translation and classification
- `@clerk/backend` — user auth + Gmail token retrieval
- `pg-workflows` — durable background workflow orchestration (classification, HIL approval, expiry sweep)
- `pg-boss` — PostgreSQL job queue (peer dependency of pg-workflows)
- `hono` — HTTP framework
- `commander` — CLI framework
- `zod` — runtime validation
- `luxon` — timezone-aware date/time for schedules and timebox computation
