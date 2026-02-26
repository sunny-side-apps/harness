# Security & Trust

## Security Model

Save My Ass is built on five core security principles:

**1. Fine-grained access on top of OAuth**
OAuth scopes are too coarse — `gmail.modify` grants an agent full inbox access forever. Save My Ass sits on top of OAuth and enforces fine-grained, attribute-based policies on every request. An agent that has passed OAuth still cannot read, mutate, or see anything that a policy does not explicitly permit.

**2. All OAuth managed by Clerk**
Save My Ass never handles, stores, or sees Google OAuth tokens. Clerk manages the full OAuth lifecycle (sign-in, token refresh, revocation). The API server fetches the user's Gmail token from Clerk at request time and uses it to call Gmail. If Clerk revokes a session, Gmail access stops immediately.

**3. No email data stored**
Save My Ass is a stateless enforcement layer. Email bodies, attachments, and full message content are never written to Save My Ass storage. The audit log stores only metadata (agent, action, resource ID, from address, subject). Gmail remains the single source of truth for email content.

**4. Human in the loop for mutating actions**
Agents cannot mutate email autonomously. Every write operation (send, reply, archive, trash) is intercepted. High and critical actions require explicit user approval before execution. Approval is delivered via the user's configured channel (Slack or Telegram).

**5. Default-deny**
If no policy matches a request, it is blocked. An agent with no policies sees nothing and can do nothing. Policies must be explicitly granted.

---

## Fine-Grained Access Control

OAuth gives coarse scopes. Save My Ass adds a policy layer on top that enforces:

- **What the agent can read** — filtered by sender, labels, classification category, subject, date
- **What the agent can do** — read, list, draft, send, archive, trash — each independently controlled
- **For how long** — timeboxed access that auto-expires
- **Under what conditions** — business hours only, specific threads, specific senders

```
OAuth scope:    gmail.modify          → full inbox access, forever
Save My Ass:    allow "openclaw" to [read, list] on gmail.messages
                  where { labels contains "sma/class/work" }
                  during weekdays(9, 17)
                  for 2h
```

The agent experiences a filtered virtual inbox. Emails it cannot access are completely invisible — not redacted, not summarized, not returned. They do not exist from the agent's perspective.

---

## Risk Tiers and Action Control

Every Gmail operation has a fixed risk tier. Tier determines the default enforcement behavior.

| Tier | Operations | Default behavior |
|---|---|---|
| **Low** | `read`, `list`, `search` | Auto-permit if policy matches |
| **Medium** | `draft`, `archive`, `label` | Auto-permit if policy matches, user notified |
| **High** | `send`, `reply` | HIL approval required |
| **Critical** | `trash`, `delete`, `modify filters`, `update settings` | HIL approval always required |

High and critical operations are never auto-executed, regardless of policy. A matching policy is necessary but not sufficient — user approval is always required.

---

## Human-in-the-Loop (HIL) Approvals

When an agent requests a high or critical action, Save My Ass:

1. Intercepts the request before any external effect
2. Creates a Gmail draft (for send/reply) or holds the action (for trash/delete)
3. Sends an approval request to the user's configured channel

**Approval channels (MVP):**
- Slack
- Telegram

**Future:** WhatsApp, Discord, Viber

### Approval Workflow

HIL approvals run as durable **pg-workflows** workflows. The workflow pauses at `step.waitFor('approval-response')` until the user responds via Slack or Telegram, then resumes and executes or cancels the action. Approval state, retries, and timeout are fully managed by the workflow engine — no custom approval table needed.

```
hil-approval workflow:
  step.run('intercept')        → create Gmail draft (for send/reply) or hold action
  step.run('notify')           → send approval request to Slack/Telegram
  step.waitFor('approval',     → pause — wait for user response
    timeout: 10 minutes)       → on timeout: delete draft, return ApprovalTimeout to agent
  step.run('execute')          → execute or cancel based on response
```

### Approval Responses

The user responds with one of four options:

| Response | Effect |
|---|---|
| `allow once` | Executes this single request. Agent must ask again next time. |
| `allow` | Grants permission for the rest of the current session. |
| `allow for <duration>` | Grants a time-bounded permit (e.g. `allow for 2h`). Compiled into a temporary Cedar policy. |
| `deny` | Blocks the request. Returns denial to agent. |

`allow for <duration>` creates a real temporary policy — compiled, validated, and stored in PostgreSQL with `source: "approval"` and an auto-expiry. This means the user's approval response feeds back into the same policy pipeline used for manually created policies.

The user triggers the workflow to resume by replying in Slack/Telegram. The approval channel integration calls `engine.triggerEvent({ eventName: 'approval-response', data: { decision, duration? } })`.

### Draft-First for Send Operations

Send and reply are a special case of HIL. When an agent requests to send an email:

1. Save My Ass creates a Gmail draft instead of sending
2. The draft is labeled `sma/pending-approval`
3. An approval request is sent to the user with the draft content
4. On `allow` / `allow once` / `allow for <duration>` → the draft is sent
5. On `deny` → the draft is deleted

Users can always open the draft directly in Gmail before approving.

### Approval Channel Configuration

Approval channels are configured per agent:

```bash
sma agent set-approval openclaw --channel slack
sma agent set-approval research-bot --channel telegram
```

If no approval channel is configured and an action requires approval, it is blocked with an explanation.

---

## Timeboxed Access

Agents should never hold standing access indefinitely. Every grant can be time-bounded and auto-expires.

### Grant Types

| Type | Description | Example |
|---|---|---|
| `for <duration>` | Relative window from grant time | `for 2h`, `for 30m` |
| `until <timestamp>` | Absolute expiry | `until "2026-03-01T00:00"` |
| `during <schedule>` | Recurring time window | `during weekdays(9, 17)` |
| `for session` | Tied to agent session lifetime | expires when session ends |

### How It Works

Time boundaries compile to Cedar conditions on `context.now`, `context.hourOfDay`, and `context.dayOfWeek`, injected by the API server on every request (see DSL.md for full details).

**Lazy evaluation** — every request checks time conditions against `context.now`. Expired grants naturally deny without any cleanup required.

**Eager cleanup** — a background sweep runs every 5 minutes to disable expired policies and keep the active set clean.

### Expiry Notifications

When a grant is approaching expiry, the user is notified via their approval channel:

```
[Save My Ass] Grant p-007 expires in 10 minutes
openclaw's read access to work emails ends at 12:00 PM

Reply with:
  extend 1h    → extend by 1 hour
  extend 2h    → extend by 2 hours
  permanent    → remove time limit
  expire       → let it expire now
```

---

## Agent Identity

Agent identity is bound to a server-side key, not self-reported. Every registered agent receives a unique key (`p_{base64_random}`) that identifies both the agent and its owner.

```bash
sma agent register "openclaw"
# → key: p_dGVhbS1vcGVuY2xhdw==
# → MCP: set Authorization: Bearer p_dGVhbS1vcGVuY2xhdw== in agent config
# → CLI: sma gmail search "..." --agent-key p_dGVhbS1vcGVuY2xhdw==
```

Keys are transmitted exclusively in the `Authorization: Bearer` header — never in the URL path, query string, or request body. This prevents key exposure in server access logs, CDN logs, and browser history.

Keys are stored as SHA-256 hashes in PostgreSQL. The raw key is shown once at registration and never stored. Revocation is immediate:

```bash
sma agent revoke "openclaw"   # all active sessions terminated instantly
```

**Gmail OAuth token invariant:** The API server fetches Gmail OAuth tokens from Clerk fresh on every request. Tokens are never cached in application memory, never written to logs, and never stored. This is a hard architectural invariant — no in-process caching of OAuth tokens is permitted.

Policy management commands (the control plane) never pass through the policy engine. An agent cannot lock a user out of their own policies. Emergency reset:

```bash
sma policy reset --emergency
```

---

## Hardcoded System-Level Rules

These rules are enforced at the API server layer and cannot be overridden by user policies:

- **Agents cannot modify classification labels.** Any attempt to update or delete a Gmail label with a name starting with `sma/` is blocked unconditionally:
  ```
  deny * to [update, delete] on gmail.labels where { name startsWith "sma/" }
  ```
- **Audit log is append-only.** The API server's database role has INSERT + SELECT only on `audit_log` — no DELETE or UPDATE.
- **OAuth tokens are never cached.** A hard architectural invariant — no in-process caching of Clerk-issued Gmail tokens.
- **Policy control plane is not agent-accessible.** Policy creation, modification, and deletion endpoints accept only Clerk-authenticated user sessions — agent keys are rejected at the route level.

---

## Audit and Transparency

Save My Ass maintains a complete audit log of every agent request, the policy decision, and the outcome. Logs are stored in PostgreSQL with append-only access controls.

### Audit Entry

```json
{
  "id": "audit-20260226-001",
  "timestamp": "2026-02-26T10:32:15Z",
  "agentId": "agent-uuid",
  "agentName": "openclaw",
  "action": "gmail:messages:read",
  "resource": {
    "type": "GmailMessage",
    "id": "msg-abc123",
    "from": "alice@work.com",
    "subject": "Project update"
  },
  "policyDecision": {
    "effect": "permit",
    "matchedPolicies": ["p-001"],
    "tier": "low"
  },
  "approvalRequired": false,
  "outcome": "executed"
}
```

For high and critical actions, the audit entry also records:
```json
{
  "approvalRequired": true,
  "approvalChannel": "slack",
  "approvalResponse": "allow for 2h",
  "outcome": "executed"
}
```

### What is never logged

- Full email bodies or attachment content
- OAuth tokens or agent keys (raw)
- Any data from emails the agent was denied access to

### Retention and visibility

- Audit logs are stored in PostgreSQL with configurable retention
- Viewable in the dashboard (read-only) and via `sma audit`
- Individual entries can be inspected: `sma audit show <id>`

---

## Abuse Detection

The API server enforces per-agent rate limits and detects anomalous query patterns.

| Protection | Threshold |
|---|---|
| Requests per minute per agent | 60 |
| Denied requests before cooldown | 10 consecutive denials |
| Anomaly detection | Unusual enumeration or probing patterns |

Agents that exceed thresholds are placed in a cooldown period. Anomalous patterns are flagged in the audit log and surfaced in the dashboard.
