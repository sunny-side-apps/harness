# Initial Implementation Plan

## Decisions Log

| Decision      | Choice                             | Rationale                                                                                  |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Monorepo      | Single package with path aliases   | Split into workspaces later when boundaries stabilize                                      |
| Database      | Docker Compose (PostgreSQL)        | Easy onboarding, reproducible                                                              |
| Migrations    | Drizzle ORM                        | Type-safe schema-as-code, excellent Bun support                                            |
| Workflows     | pg-workflows (npm)                 | Confirmed Bun-compatible, exactly-once semantics, pg-boss backed                           |
| CLI framework | Commander                          | As specced                                                                                 |
| Cedar         | @cedar-policy/cedar-wasm           | Test with Bun first; fallback to tempire/cedar-wasm-js fork if ESM issue (#1226) blocks us |
| LLM           | Claude Haiku via @anthropic-ai/sdk | Fast and cheap for both NL translation and classification                                  |
| MCP SDK       | @modelcontextprotocol/sdk          | Official TypeScript SDK                                                                    |
| HIL approvals | Mock/stub first                    | Build the broker interface, stub with CLI prompt/webhook for dev                           |
| Dashboard     | Deferred                           | Build last, after all backend services are functional                                      |
| CI/CD         | Deferred                           | Focus on application code first                                                            |
| Config        | dotenv + Zod validation            | .env files with Zod schema validation at startup                                           |
| First slice   | Policy engine + CLI                | Core value prop, minimal external dependencies                                             |

---

## Phase 0 — Project Foundation

**Goal:** Establish project structure, dev tooling, and database setup so all subsequent phases can build on solid ground.

### 0.1 Project Structure

Create the directory layout from ARCHITECTURE.md as a single package with path aliases:

```
savemyass/
├── package.json
├── tsconfig.json
├── docker-compose.yml
├── .env.example
├── drizzle.config.ts
├── src/
│   ├── api/                          # API server (Hono)
│   │   ├── server.ts                 # Hono app setup + entry point
│   │   └── routes/
│   │       ├── agents.ts
│   │       ├── policies.ts
│   │       ├── gmail.ts
│   │       ├── grants.ts
│   │       └── audit.ts
│   ├── mcp/                          # MCP adapter
│   │   ├── server.ts
│   │   └── tools.ts
│   ├── compiler/
│   │   ├── parser.ts
│   │   ├── resolver.ts
│   │   ├── typechecker.ts
│   │   ├── conflicts.ts
│   │   ├── emitter.ts
│   │   └── errors.ts
│   ├── runtime/
│   │   ├── engine.ts
│   │   ├── policy-engine.ts
│   │   ├── filter.ts
│   │   └── context.ts
│   ├── classification/
│   │   ├── rules.ts
│   │   ├── llm.ts
│   │   └── labels.ts
│   ├── nl/
│   │   ├── translator.ts
│   │   ├── clarifier.ts
│   │   └── summary.ts
│   ├── timebox/
│   │   └── grants.ts
│   ├── approval/
│   │   ├── broker.ts
│   │   ├── slack.ts
│   │   ├── telegram.ts
│   │   └── stub.ts                   # Mock approval for dev
│   ├── workflows/
│   │   ├── engine.ts
│   │   ├── classification-onboarding.ts
│   │   ├── classification-incremental.ts
│   │   ├── hil-approval.ts
│   │   └── expiry-sweep.ts
│   ├── db/
│   │   ├── schema.ts                 # Drizzle schema
│   │   ├── client.ts                 # Database connection
│   │   └── migrations/
│   ├── config/
│   │   └── env.ts                    # Zod-validated env config
│   └── shared/
│       ├── types.ts                  # Shared type definitions
│       └── errors.ts                 # Application error types
├── bin/
│   └── main.ts                       # CLI entry point
├── packages/
│   └── skill/
│       └── SKILL.md
└── docs/
```

### 0.2 Dependencies

```bash
# Core
bun add hono drizzle-orm pg pg-boss pg-workflows zod commander luxon

# Cedar (test Bun compat first)
bun add @cedar-policy/cedar-wasm

# Auth & external services
bun add @clerk/backend @anthropic-ai/sdk

# MCP
bun add @modelcontextprotocol/sdk

# Dev
bun add -d drizzle-kit @types/pg @types/luxon
```

### 0.3 Configuration (src/config/env.ts)

Zod schema validating all required env vars at startup:

```
DATABASE_URL          # PostgreSQL connection string
CLERK_SECRET_KEY      # Clerk backend API key
ANTHROPIC_API_KEY     # For NL translation + classification
MCP_SERVICE_SECRET    # Shared secret for MCP→API auth
API_PORT              # Default 3000
MCP_PORT              # Default 3001
```

### 0.4 Docker Compose

```yaml
services:
  postgres:
    image: postgres:16
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: savemyass
      POSTGRES_USER: savemyass
      POSTGRES_PASSWORD: savemyass
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

### 0.5 Database Schema (Drizzle)

Implement all tables from ARCHITECTURE.md data model:

- `users` — mirrors Clerk
- `agents` — registered agents with key_hash
- `active_sessions` — MCP session tracking
- `policies` — compiled Cedar policies + DSL source
- `session_grants` — once/session grants from HIL approvals
- `audit_log` — append-only audit trail

### 0.6 Cedar WASM Compatibility Spike

Before proceeding, verify @cedar-policy/cedar-wasm works with Bun:

1. Install the package
2. Write a minimal test: create a PolicySet, validate against a schema, evaluate a request
3. If ESM import fails, try the `/nodejs` subpath
4. If that fails, switch to `tempire/cedar-wasm-js` fork
5. Document the outcome and any workarounds needed

**Exit criteria:** Cedar policy evaluation works in Bun. A test proves it.

---

## Phase 1 — DSL Compiler

**Goal:** Parse AgentGate DSL strings into validated Cedar policies. This is the core intellectual property — get it right.

### 1.1 DSL Parser (src/compiler/parser.ts)

Hand-written recursive descent parser (the DSL is small enough; no need for a parser generator).

**Input:** DSL string
**Output:** Unresolved AST

AST node types:

```typescript
type PolicyAST = {
  kind: "allow" | "deny" | "noaction";
  agent: string | "*"; // agent name or wildcard
  operations: string[] | ["*"]; // read, list, send, etc.
  resource: { service: string; type: string }; // gmail.messages
  conditions?: Condition[];
  timeBound?: TimeBound;
  requiresApproval?: { operations: string[] };
};

type Condition = {
  attribute: string;
  operator: string;
  value: string | string[] | number | boolean;
};

type TimeBound =
  | { kind: "duration"; seconds: number } // for 2h
  | { kind: "until"; timestamp: string } // until "2026-03-01"
  | { kind: "schedule"; schedule: Schedule } // during weekdays(9,17)
  | { kind: "session" }; // for session
```

**Test cases:**

- All examples from DSL.md
- Edge cases: wildcard agents, wildcard operations, multiple conditions, combined time+conditions
- Error cases: unknown keywords, malformed durations, unclosed braces

### 1.2 Resolver (src/compiler/resolver.ts)

Links AST references to the known Gmail resource model.

- Validates agent names exist (or are wildcards)
- Validates operations are known verbs: `read`, `list`, `send`, `draft`, `archive`, `trash`
- Validates resource paths: `gmail.messages`, `gmail.threads`
- Validates condition attributes exist on the resource entity: `from`, `to`, `subject`, `labels`, `date`, `threadId`
- Maps DSL operations to Cedar action names: `read` → `gmail:messages:read`
- `noaction` expands to deny with all operations

**Output:** Resolved AST (all references validated)

### 1.3 Type Checker (src/compiler/typechecker.ts)

Validates that condition operators are valid for the attribute type:

| Attribute  | Type          | Valid operators                                     |
| ---------- | ------------- | --------------------------------------------------- |
| `from`     | String        | `==`, `!=`, `like`, `startsWith`, `endsWith`        |
| `to`       | Set\<String\> | `contains`, `containsAny`, `containsAll`, `isEmpty` |
| `subject`  | String        | `==`, `!=`, `like`, `startsWith`, `endsWith`        |
| `labels`   | Set\<String\> | `contains`, `containsAny`, `containsAll`, `isEmpty` |
| `date`     | Long          | `==`, `!=`, `>`, `<`, `>=`, `<=`                    |
| `threadId` | String        | `==`, `!=`                                          |

Errors are rich and actionable: "Operator '>' is not valid for attribute 'from' (type String). Did you mean 'like'?"

### 1.4 Conflict Detection (src/compiler/conflicts.ts)

Analyzes the new policy against existing active policies:

- **Shadowed allows:** An allow that will never match because a broader deny covers it → error
- **Redundant rules:** A policy that is already covered by an existing policy → warning
- **Delegation violations:** A policy that grants more than the agent's delegated ceiling → error (future, but stub the interface)

Errors block activation. Warnings require acknowledgment (in CLI: prompt user).

### 1.5 Cedar Emitter (src/compiler/emitter.ts)

Transforms resolved+validated AST into Cedar policy strings.

Mapping:

- `allow` → `permit(...) when { ... }`
- `deny` → `forbid(...) when { ... }`
- `noaction` → `forbid(...)` with all actions
- Agent `"openclaw"` → `principal == AgentGate::Agent::"openclaw"`
- Agent `*` → no principal constraint
- `where { from: "*@team.com" }` → `resource.from like "*@team.com"`
- `for 2h` → `context.grantedAt + 7200 > context.now`
- `during weekdays(9, 17)` → `context.dayOfWeek >= 1 && context.dayOfWeek <= 5 && context.hourOfDay >= 9 && context.hourOfDay < 17`
- `until <timestamp>` → `context.now < <unix_timestamp>`

Also extracts the **application sidecar**:

- `requires approval for [archive]` → `{ requiresApproval: ["gmail:messages:archive"] }`
- `for session` → `{ sessionScoped: true }`

### 1.6 Cedar Validation

After emitting, validate the policy set against the Cedar schema (from DSL.md) using `@cedar-policy/cedar-wasm`. Reject if validation fails.

### 1.7 Compiler Orchestrator

Single entry point that runs all phases in sequence:

```typescript
function compile(dsl: string, existingPolicies: Policy[]): CompileResult {
  const ast = parse(dsl); // Phase 1: Parse
  const resolved = resolve(ast); // Phase 2: Resolve
  typecheck(resolved); // Phase 3: Type-check
  checkConflicts(resolved, existingPolicies); // Phase 4: Conflicts
  const { cedar, sidecar } = emit(resolved); // Phase 5: Emit
  validateCedar(cedar); // Phase 6: Cedar validation
  return { cedar, sidecar, ast: resolved };
}
```

If any phase throws, the active policy set is untouched.

**Test cases:** Full pipeline tests using every example from DSL.md (NL → DSL → Cedar).

---

## Phase 2 — Policy Runtime Engine

**Goal:** Evaluate Cedar policies against live requests. Default-deny.

### 2.1 Policy Engine (src/runtime/policy-engine.ts)

Wraps `@cedar-policy/cedar-wasm`:

- Load Cedar schema once at startup
- Load policy set from PostgreSQL per agent request
- Atomic swap: in-flight requests finish with old set, next request gets new set
- Failure mode: if Cedar throws → deny + log error

```typescript
class PolicyEngine {
  evaluate(request: PolicyRequest): PolicyDecision;
  loadPolicies(agentId: string): void;
  swapPolicies(agentId: string, newSet: string): void;
}
```

### 2.2 Request Engine (src/runtime/engine.ts)

Orchestrates the full evaluation flow per request:

1. Check no-action zones first (early exit)
2. Check sidecar: session grants, approval requirements
3. Evaluate Cedar policy set
4. Return unified `PolicyDecision`: `permit | deny | pending_approval`

### 2.3 Context Builder (src/runtime/context.ts)

Builds the Cedar context object injected on every evaluation:

```typescript
{
  now: number,          // Unix timestamp
  grantedAt: number,    // Policy creation timestamp
  hourOfDay: number,    // 0-23, user's timezone
  dayOfWeek: number     // 1=Mon, 7=Sun
}
```

Uses Luxon for timezone-aware computation.

### 2.4 Post-Fetch Filter (src/runtime/filter.ts)

For read operations:

1. Extract attributes from each Gmail message (from, to, subject, labels, date)
2. Evaluate each message against the policy engine
3. Strip unauthorized messages — they become invisible
4. If filtered count < requested limit, signal to over-fetch (up to 3 rounds)

---

## Phase 3 — CLI (`sma`)

**Goal:** Working CLI that can manage agents, policies, and issue Gmail commands — all routed through the policy engine via the API server.

### 3.1 CLI Scaffold (bin/main.ts)

Commander-based CLI with subcommands matching ARCHITECTURE.md:

```
sma auth login
sma agent register / list / revoke
sma agent set-approval <name> --channel <slack|telegram>
sma policy add / list / show / disable / remove
sma policy reset --emergency
sma grant / revoke / grants
sma gmail search / read / send / draft / archive / trash / labels / watch
sma audit / audit show <id>
```

### 3.2 Policy Management Commands

`sma policy add "<natural language or DSL>"`:

1. Detect if input is NL or DSL (heuristic: DSL starts with `allow`/`deny`/`noaction`)
2. If NL → call NL translator (Phase 5) → show DSL for confirmation
3. Compile DSL → Cedar via compiler (Phase 1)
4. Show validation results (conflicts, warnings)
5. On confirm → store in PostgreSQL
6. On cancel → discard

`sma policy list`: Table of active policies with ID, agent, DSL summary, expiry.
`sma policy show <id>`: Full policy detail including Cedar output.
`sma policy disable/remove <id>`: Deactivate or delete.

### 3.3 Agent Management Commands

`sma agent register "<name>"`:

1. Generate key: `crypto.randomBytes(32)` → base64url → prefix with `sma_`
2. Hash with SHA-256, store hash + prefix in PostgreSQL
3. Display raw key once — never stored

`sma agent list`: Table of agents with name, key prefix, created, status.
`sma agent revoke "<name>"`: Set `revoked_at`, deny all subsequent requests.

### 3.4 Gmail Commands

All Gmail commands call the API server (not Gmail directly):

- `sma gmail search` → `POST /gmail/search`
- `sma gmail read <id>` → `POST /gmail/read`
- etc.

Each request includes `Authorization: Bearer sma_{key}` (from `--agent-key` flag or stored config).

Human user commands (no `--agent-key`) authenticate via Clerk session token from `sma auth login`.

---

## Phase 4 — API Server

**Goal:** Hono HTTP server implementing all business logic. Every other component is a client of this server.

### 4.1 Server Setup (src/api/server.ts)

Hono app with:

- Health check endpoint
- Authentication middleware (two paths):
  - Agent key auth: `Authorization: Bearer sma_{key}` → resolve to (userId, agentId)
  - User session auth: Clerk session token → resolve to userId
  - Service auth: `Authorization: Bearer {mcp-service-secret}` for MCP→API calls
- Error handling middleware (structured JSON errors)
- Rate limiting middleware (60 req/min per agent)

### 4.2 Agent Routes (src/api/routes/agents.ts)

- `POST /agents` — register agent (user auth required)
- `GET /agents` — list agents (user auth required)
- `DELETE /agents/:id` — revoke agent (user auth required)
- `PATCH /agents/:id/approval` — set approval channel

### 4.3 Policy Routes (src/api/routes/policies.ts)

- `POST /policies` — compile + store policy
- `GET /policies` — list active policies
- `GET /policies/:id` — show policy detail
- `PATCH /policies/:id` — disable/enable
- `DELETE /policies/:id` — remove policy
- `POST /policies/reset` — emergency reset (user auth, deletes all)

### 4.4 Gmail Routes (src/api/routes/gmail.ts)

All Gmail routes follow the request flow from ARCHITECTURE.md:

- `POST /gmail/search` — search with policy enforcement + post-fetch filtering
- `POST /gmail/read` — read single message with policy check
- `POST /gmail/draft` — create draft (medium risk tier)
- `POST /gmail/send` — draft-first: create draft + trigger approval
- `POST /gmail/archive` — archive with policy check (medium risk)
- `POST /gmail/trash` — trash with approval (critical risk)
- `GET /gmail/labels` — list accessible labels

Internal routes (MCP→API, same logic but service-secret auth):

- `POST /internal/gmail/search`
- `POST /internal/gmail/read`
- etc.

### 4.5 Audit Routes (src/api/routes/audit.ts)

- `GET /audit` — paginated audit log (user auth)
- `GET /audit/:id` — single audit entry

### 4.6 Grant Routes (src/api/routes/grants.ts)

- `POST /grants` — create timeboxed grant
- `GET /grants` — list active grants
- `DELETE /grants/:id` — revoke grant

---

## Phase 5 — NL Translation

**Goal:** Convert natural language policy descriptions to AgentGate DSL using Claude Haiku.

### 5.1 NL Translator (src/nl/translator.ts)

Calls Anthropic API with a structured prompt:

- System prompt defines the DSL grammar, all valid operations, attributes, time constructs
- User message is the natural language input
- Output is a single DSL statement
- Uses tool_use to get structured output (DSL string + confidence + ambiguities)

### 5.2 Ambiguity Detector (src/nl/clarifier.ts)

When the translator returns low confidence or multiple interpretations:

- Surface clarifying questions to the user
- Re-translate with the clarified input
- Examples: "team emails" → which team domain? "for a while" → how long exactly?

### 5.3 Summary Generator (src/nl/summary.ts)

Converts compiled DSL back to a human-readable summary for confirmation:

```
This grants openclaw:
  ✓ Read and list Gmail messages
  ✓ Only from *@team.com senders
  ✓ Expires in 2 hours
```

---

## Phase 6 — Email Classification

**Goal:** Classify inbox emails with Gmail labels. Deterministic rules first, LLM fallback.

### 6.1 Deterministic Rules (src/classification/rules.ts)

Implement all rules from CLASSIFICATION.md:

- Known sender patterns (GitHub, Linear, Stripe, etc.)
- Subject patterns (verification codes, shipping, invoices, etc.)
- Header patterns (List-Unsubscribe, bulk mailer headers)

Each rule returns one or more labels. Rules are evaluated in priority order.

### 6.2 LLM Classification (src/classification/llm.ts)

For emails that don't match deterministic rules:

- Send `from`, `subject`, first 200 chars of snippet to Claude Haiku
- Parse JSON array of categories
- Fallback to `sma/class/unknown` on LLM failure

### 6.3 Gmail Label Management (src/classification/labels.ts)

- Create `sma/class/*` labels in Gmail if they don't exist
- Apply labels to messages via Gmail API
- Check for existing labels before classifying (idempotency)

---

## Phase 7 — Workflows

**Goal:** Durable background jobs for classification, approval, and expiry using pg-workflows.

### 7.1 Workflow Engine Setup (src/workflows/engine.ts)

Initialize pg-workflows with pg-boss connection. Register all workflows.

### 7.2 Classification Onboarding (src/workflows/classification-onboarding.ts)

As specced in CLASSIFICATION.md:

- Paginate through inbox
- Checkpoint after each page (pg-workflows step)
- Skip already-classified messages
- Generate default policies after completion

### 7.3 Classification Incremental (src/workflows/classification-incremental.ts)

Triggered by Gmail push notifications:

- Fetch single message
- Classify (deterministic → LLM fallback)
- Apply label

### 7.4 HIL Approval (src/workflows/hil-approval.ts)

- `step.waitFor('approval-response')` to pause until user responds
- Timeout after 10 minutes → deny
- On response: execute, create grant, or deny based on user choice

### 7.5 Expiry Sweep (src/workflows/expiry-sweep.ts)

Runs every minute:

- Disable expired policies (`expires_at < now`)
- Clean up ended sessions
- Delete consumed one-time grants

---

## Phase 8 — MCP Server

**Goal:** Thin MCP protocol adapter translating MCP tool calls to API server calls.

### 8.1 MCP Server (src/mcp/server.ts)

Using `@modelcontextprotocol/sdk`:

- Expose 6 tools: `search_emails`, `read_email`, `draft_email`, `archive_email`, `trash_email`, `list_labels`
- Extract agent key from Authorization header
- Forward every call to API server with service secret
- No business logic, no DB access

### 8.2 MCP Tool Definitions (src/mcp/tools.ts)

Define input/output schemas per the ARCHITECTURE.md MCP tools table.

---

## Phase 9 — Approval Channels

**Goal:** Build the approval broker interface and a stub implementation for development.

### 9.1 Approval Broker (src/approval/broker.ts)

Interface:

```typescript
interface ApprovalBroker {
  sendApprovalRequest(request: ApprovalRequest): Promise<void>;
  // Responses come back via webhook/event, not return value
}
```

Dispatches to the configured channel per agent.

### 9.2 Stub Approval (src/approval/stub.ts)

For development:

- Logs the approval request to console
- Exposes a local HTTP endpoint to submit approval responses
- Auto-approve mode for testing

### 9.3 Slack Integration (src/approval/slack.ts)

Deferred to post-stub phase. Skeleton with interface compliance.

### 9.4 Telegram Integration (src/approval/telegram.ts)

Deferred to post-stub phase. Skeleton with interface compliance.

---

## Phase 10 — AgentSkill

**Goal:** Ship the SKILL.md that tells compatible agents how to connect.

### 10.1 SKILL.md (packages/skill/SKILL.md)

Document:

- MCP server URL and authentication
- Available tools and their schemas
- CLI alternative with `--agent-key`
- Example usage flows

---

## Implementation Order

```
Phase 0  ─── Foundation (structure, deps, DB, Cedar spike)
  │
Phase 1  ─── DSL Compiler (parser → resolver → typechecker → emitter)
  │
Phase 2  ─── Policy Runtime (Cedar engine, context, filter)
  │
Phase 3  ─── CLI (agent mgmt, policy mgmt commands)
  │
Phase 4  ─── API Server (Hono, routes, auth middleware)
  │
  ├── Phase 5  ─── NL Translation (can run in parallel with Phase 6)
  ├── Phase 6  ─── Email Classification (can run in parallel with Phase 5)
  │
Phase 7  ─── Workflows (pg-workflows integration)
  │
Phase 8  ─── MCP Server (thin adapter)
  │
Phase 9  ─── Approval Channels (stub → Slack → Telegram)
  │
Phase 10 ─── AgentSkill (SKILL.md)
```

Phases 5 and 6 can be developed in parallel since they have no dependencies on each other. All other phases are sequential — each builds on the previous.

---

## Testing Strategy

- **Unit tests** for every compiler phase (parser, resolver, typechecker, emitter) — these are pure functions, highly testable
- **Unit tests** for classification rules (deterministic matcher)
- **Integration tests** for the full compiler pipeline (DSL → Cedar)
- **Integration tests** for the policy engine (Cedar evaluation with mocked Gmail data)
- **Integration tests** for API routes (Hono test client + test database)
- **All tests run with Bun's native test runner** (`bun test`)

---

## Risk Register

| Risk                                    | Mitigation                                                |
| --------------------------------------- | --------------------------------------------------------- |
| cedar-wasm ESM issue with Bun           | Phase 0.6 spike. Fallback: tempire/cedar-wasm-js fork     |
| pg-workflows API changes (v0.2.0)       | Pin version, vendor if needed                             |
| Clerk Gmail token retrieval complexity  | Spike in Phase 4 before building Gmail routes             |
| LLM classification costs at scale       | Deterministic rules handle majority; LLM is fallback only |
| Gmail API rate limits during onboarding | Pagination with backoff, checkpoint per page              |
