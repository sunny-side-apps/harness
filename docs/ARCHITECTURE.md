# Architecture & Implementation

## System Overview

Save My Ass is a cloud-hosted policy enforcement layer that gives AI agents fine-grained, auditable access to Gmail — going beyond what OAuth scopes can express.

**The core problem:** OAuth grants are too coarse. `gmail.modify` gives an agent full inbox access forever. Save My Ass lets users say "openclaw can read emails from my team, for 2 hours, nothing else."

**How agents connect:** Save My Ass exposes an **MCP server** at `https://mcp.savemyass.com/p_{key}`. Each registered agent gets a unique key. The agent connects to the MCP server and uses semantic tools (`search_emails`, `read_email`, `draft_email`) instead of the Gmail API directly. Policy enforcement happens server-side on every tool call.

**How agents discover it:** Save My Ass ships as an **AgentSkill** — a SKILL.md distributed via agentskills.io that tells any compatible agent (Claude Code, OpenClaw, Cursor, OpenHands, etc.) how to connect to the MCP server. The AgentSkill is the distribution mechanism; the MCP server is the enforcement point.

**How users manage it:** Via a **CLI** (`sma`) for policy creation, agent registration, grants, and email management. A read-only **React dashboard** shows active policies and audit history.

**Stack:** TypeScript + Bun + Hono, PostgreSQL, Fly.io, Clerk (auth + Google OAuth).

---

## Components

### 1. API Server (`api.savemyass.com`)

The core service. Contains all business logic: policy enforcement, Gmail API calls, audit logging, agent key resolution, and policy compilation. Every other component is a client of the API server.

### 2. MCP Server (`mcp.savemyass.com`)

A thin MCP protocol adapter. Translates MCP tool calls into API server calls. No direct database access, no business logic. Stateless and horizontally scalable.

MCP tools exposed:
- `search_emails(query, filters)`
- `read_email(id)`
- `draft_email(to, subject, body)`
- `archive_email(id)`
- `trash_email(id)`
- `list_labels()`

### 3. Policy Engine

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

Dual-purpose tool: full Google Workspace email client for humans and agents, with every command routed through the policy engine via the API server.

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

**For agents (via AgentSkill):** `sma` accepts `--agent-key p_{key}` to identify the calling agent. Every command is evaluated against that agent's policies before execution.

### 7. AgentSkill

A SKILL.md file distributed via agentskills.io. Tells compatible agents (Claude Code, OpenClaw, Cursor, OpenHands, GitHub Copilot, etc.) how to connect to the MCP server or use `sma` commands. Discovery and onboarding mechanism — no runtime role.

---

## Request Flow

Agents connect via two paths: MCP for hosted and MCP-native agents, CLI for shell-capable agents.

### Read operations (MCP path)

```
Agent calls search_emails(query="from:team@company.com")
  1. MCP server resolves p_{key} → API server
  2. API server resolves p_{key} → (userId, agentId)
  3. Load agent's active policies from PostgreSQL
  4. Policy engine checks if the agent is allowed to perform this action at all
     (no gmail.read policy → block immediately)
  5. [Optional] If a policy condition maps directly to a Gmail search filter,
     append it to the query as an optimization
  6. Fetch Gmail OAuth token from Clerk
  7. Forward request to Gmail API
  8. Gmail returns full results
  9. Extract attributes from each result (from, to, subject, labels, date)
  10. Policy engine evaluates each item — unauthorized items stripped
  11. Return filtered results to agent
  12. Write audit entry to PostgreSQL
```

### Read operations (CLI/AgentSkill path)

```
Agent runs: sma gmail search "from:team@company.com" --agent-key p_{key}
  1. sma calls API server with p_{key}
  2-12. Same enforcement pipeline as MCP path
```

Post-fetch filtering (step 10) is the primary enforcement point. Step 4 is a cheap early exit. Step 5 is an optional optimization. The agent never knows filtering happened — unauthorized emails are completely invisible.

### Write operations (both paths)

```
Agent calls draft_email / sma gmail send
  1-4. Same resolution and policy check as read path
  5. Classify action risk tier:
       draft, archive, label  → medium  (auto-allow, notify user)
       send, reply            → high    (create Gmail draft, label pending-approval)
       trash, delete          → critical (block + send approval request via Slack/Telegram)
  6. Return result to agent
  7. Write audit entry to PostgreSQL
```

---

## Authentication & Agent Identity

### User authentication

Handled entirely by Clerk. Users sign up with Google — Clerk runs the OAuth flow and manages the Gmail access token. Save My Ass stores nothing OAuth-related. When the API server needs to call Gmail on behalf of a user, it fetches the token from Clerk at request time.

### Agent identity

Each registered agent gets a unique key (`p_{base64_random}`). The key is the full identifier — it encodes both the user and the agent. There is no separate user ID in the request path.

```bash
sma agent register "openclaw"
# Returns: https://mcp.savemyass.com/p_dGVhbS1vcGVuY2xhdw==
# Use as MCP server URL, or pass as --agent-key to sma commands
```

On every request, the API server looks up the key in PostgreSQL. If the key does not exist, is revoked, or the account is inactive — deny immediately, before any policy evaluation.

**Key security:**
- Generated with `crypto.randomBytes`, base64url-encoded
- Transmitted over HTTPS only
- Stored hashed in PostgreSQL
- Revocation is immediate — `sma agent revoke "openclaw"` invalidates all sessions instantly

Agent identity is bound to the key server-side. Agents cannot claim to be a different agent.

---

## Email Classification

On user onboarding, Save My Ass runs a classification job across the inbox and applies Gmail labels. These labels are the foundation for writing meaningful policies — they turn vague intent into enforceable rules.

### Classification taxonomy (`sma/class/...`)

| Label | Description |
|---|---|
| `sma/class/auth` | Password resets, login codes, 2FA, security alerts |
| `sma/class/alert` | System alerts, monitoring, error notifications |
| `sma/class/notification` | App notifications, mentions, activity updates |
| `sma/class/comment` | Code review comments, document comments, PR reviews |
| `sma/class/subscription` | Subscription confirmations, renewal reminders |
| `sma/class/marketing` | Promotional emails, newsletters, offers |
| `sma/class/receipt` | Invoices, purchase confirmations, billing |
| `sma/class/calendar` | Meeting invites, calendar updates, RSVPs |
| `sma/class/personal` | Emails from friends and family |
| `sma/class/work` | Emails from colleagues and work contacts |
| `sma/class/finance` | Bank statements, financial notifications |
| `sma/class/shipping` | Order tracking, delivery updates |

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
  key_hash    text not null,      -- hashed p_{key}
  key_prefix  text not null,      -- p_{first8} for display
  created_at  timestamptz,
  revoked_at  timestamptz
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
  version          integer
)

-- Audit log
audit_log (
  id               uuid primary key,
  agent_id         uuid references agents,
  action           text,           -- read, search, draft, send, archive
  resource_type    text,           -- gmail.message
  resource_id      text,
  decision         text,           -- permit, deny
  matched_policies uuid[],
  outcome          text,           -- executed, blocked, pending_approval
  created_at       timestamptz
)
```

---

## Deployment

```
app.savemyass.com  (React dashboard)  ─┐
mcp.savemyass.com  (MCP adapter)      ─┼──→  api.savemyass.com  →  PostgreSQL
sma CLI                               ─┘            │
                                                     └──→  Gmail API (via Clerk token)
```

All services run on Fly.io. The API server contains all business logic — the MCP server and CLI are thin clients. Adding a new interface (REST, webhook, etc.) is a thin adapter on top of the same API.

**CLI distribution:** `sma` is distributed as a standalone binary compiled with Bun. Users authenticate once:
```bash
sma auth login    # opens browser → Clerk → saves session token locally
```

**Scaling:** The MCP server and API server are stateless. Both scale horizontally on Fly.io. Policy sets are loaded from PostgreSQL per request.

---

## MVP Scope

**Included:**
- User signup via Clerk + Google OAuth
- Inbox classification on onboarding + incremental via push notifications
- Agent registration + key generation (`p_{key}`)
- Policy management via `sma` CLI — natural language and DSL
- Policy compiler: NL → AgentGate DSL → Cedar
- Policy engine: Cedar-based default-deny evaluation
- Gmail operations via `sma` and MCP: search, read, draft, archive, trash
- Post-fetch result filtering per active policies
- Timeboxed access (`for 2h`, `during weekdays(9,17)`, `for session`)
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
│   │       │   ├── grants.ts         # Grant creation + parsing
│   │       │   └── expiry.ts         # Expiry checks + cleanup sweep
│   │       ├── approval/
│   │       │   ├── broker.ts         # Approval request dispatch
│   │       │   ├── slack.ts          # Slack integration
│   │       │   └── telegram.ts       # Telegram integration
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
    └── sma.ts                        # CLI entry point
```

### Key Dependencies

- `@cedar-policy/cedar-wasm` — policy evaluation runtime
- `@anthropic-ai/sdk` — LLM for NL → DSL translation and classification
- `@clerk/backend` — user auth + Gmail token retrieval
- `hono` — HTTP framework
- `commander` — CLI framework
- `zod` — runtime validation
- `luxon` — timezone-aware date/time for schedules and timebox computation
