---
name: compiler-runtime
description: >
  Builds the DSL compiler pipeline (parser, resolver, typechecker, conflict detection, Cedar emitter)
  and the Cedar-based policy runtime engine (evaluation, context builder, post-fetch filter).
  Also builds the Hono API server with all routes, middleware, and auth.
  This is the critical-path agent — all other agents depend on its output.
  Use this agent for Phase 1 (compiler), Phase 2 (runtime), and Phase 4 (API server) of the implementation plan.
model: sonnet
tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - WebSearch
  - WebFetch
---

# Compiler, Runtime & API Server Agent

You are building the core of Save My Ass — the DSL compiler, policy runtime engine, and API server.

## Your Phases (execute in order)

### Phase 1 — DSL Compiler (`src/compiler/`)

Build a hand-written recursive descent parser for the AgentGate DSL and all downstream compiler phases.

**Files you own:**
- `src/compiler/parser.ts` — DSL string → unresolved AST
- `src/compiler/resolver.ts` — AST → resolved AST (validate references)
- `src/compiler/typechecker.ts` — validate condition operators per attribute type
- `src/compiler/conflicts.ts` — detect shadowed allows, redundant rules
- `src/compiler/emitter.ts` — resolved AST → Cedar policy strings + application sidecar
- `src/compiler/errors.ts` — rich, actionable error messages
- `src/compiler/__tests__/*.test.ts` — comprehensive tests for every phase

**DSL Grammar:**

```
allow <agent> to [<operations>] on <service>.<resource>
  [where { <conditions> }]
  [for <duration> | during <schedule> | until <timestamp> | for session]
  [requires approval [for [<operations>]]]

deny <agent> to [<operations>] on <service>.<resource>
  [where { <conditions> }]
  [for <duration> | during <schedule> | until <timestamp> | for session]

noaction <agent> on <service>.<resource>
  [for <duration> | during <schedule> | until <timestamp> | for session]
```

**AST types** are defined in `src/shared/types.ts`. Import them — do not redefine.

**Key DSL→Cedar mappings:**
- `allow` → `permit(...) when { ... }`
- `deny` → `forbid(...) when { ... }`
- `noaction` → `forbid(...)` with all actions
- Agent `"openclaw"` → `principal == AgentGate::Agent::"openclaw"`
- Agent `*` → no principal constraint
- `where { from: "*@team.com" }` → `resource.from like "*@team.com"`
- `where { labels contains "sma/class/work" }` → `resource.labels.contains("sma/class/work")`
- `for 2h` → `context.grantedAt + 7200 > context.now`
- `during weekdays(9, 17)` → `context.dayOfWeek >= 1 && context.dayOfWeek <= 5 && context.hourOfDay >= 9 && context.hourOfDay < 17`
- `until <timestamp>` → `context.now < <unix_timestamp>`
- `requires approval for [archive]` → sidecar: `{ requiresApproval: ["gmail:messages:archive"] }`
- `for session` → sidecar: `{ sessionScoped: true }`

**Condition operators by type:**

| Type | Operators |
|---|---|
| String | `==`, `!=`, `like` (glob with `*`), `startsWith`, `endsWith` |
| Set\<String\> | `contains`, `containsAny`, `containsAll`, `isEmpty` |
| Long | `==`, `!=`, `>`, `<`, `>=`, `<=` |
| Bool | `==`, `!=` |

**Attribute types:**

| Attribute | Type |
|---|---|
| `from` | String |
| `to` | Set\<String\> |
| `subject` | String |
| `labels` | Set\<String\> |
| `date` | Long |
| `threadId` | String |

**Compiler orchestrator** — single entry point:
```typescript
function compile(dsl: string, existingPolicies: Policy[]): CompileResult {
  const ast = parse(dsl);
  const resolved = resolve(ast);
  typecheck(resolved);
  checkConflicts(resolved, existingPolicies);
  const { cedar, sidecar } = emit(resolved);
  validateCedar(cedar);
  return { cedar, sidecar, ast: resolved };
}
```

**Test every example from the docs:**

| DSL | Expected Cedar |
|---|---|
| `allow "openclaw" to [read, list] on gmail.messages where { from: "*@team.com" } for 2h` | permit with principal, two actions, `resource.from like "*@team.com"`, time condition |
| `deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }` | forbid with no principal constraint, all actions, label condition |
| `allow "openclaw" to [read, list] on gmail.messages where { labels contains "sma/class/work" } during weekdays(9, 17)` | permit with dayOfWeek + hourOfDay conditions |
| `allow "research-bot" to [read, list, archive] on gmail.messages where { labels contains "sma/class/notification" } requires approval for [archive]` | permit for read+list with condition; sidecar has requiresApproval for archive |
| `noaction * on gmail.messages for 2h` | forbid all actions with time condition |

### Phase 2 — Policy Runtime Engine (`src/runtime/`)

Build the Cedar evaluation engine that runs on every request.

**Files you own:**
- `src/runtime/policy-engine.ts` — wraps @cedar-policy/cedar-wasm, loads/swaps policy sets
- `src/runtime/engine.ts` — orchestrates full evaluation: no-action zones → sidecar → Cedar
- `src/runtime/context.ts` — builds Cedar context (now, grantedAt, hourOfDay, dayOfWeek)
- `src/runtime/filter.ts` — post-fetch filtering of Gmail messages
- `src/runtime/__tests__/*.test.ts`

**Cedar schema (load at startup):**
```cedar
namespace AgentGate {
  entity Agent;
  entity GmailMessage {
    from: String, to: Set<String>, subject: String,
    labels: Set<String>, date: Long, threadId: String,
  };
  entity GmailThread {
    from: Set<String>, subject: String,
    labels: Set<String>, date: Long,
  };
  action "gmail:messages:read" appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:list" appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:draft" appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:send" appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:archive" appliesTo { principal: Agent, resource: GmailMessage };
  action "gmail:messages:trash" appliesTo { principal: Agent, resource: GmailMessage };
}
```

**PolicyEngine behavior:**
- Default-deny: no matching policy → deny
- Cedar throws → fail closed (deny, log error)
- Policy set fails to load → fail closed (503)
- Corrupted policy → keep previous valid set

**Post-fetch filter (filter.ts):**
1. Extract attributes from each Gmail message
2. Evaluate each against policy engine
3. Strip unauthorized messages (completely invisible to agent)
4. If filtered count < requested limit, signal over-fetch (max 3 rounds)

### Phase 4 — API Server (`src/api/`)

Build the Hono HTTP server with all routes and middleware.

**Files you own:**
- `src/api/server.ts` — Hono app setup, middleware stack
- `src/api/middleware/auth.ts` — three auth paths (agent key, Clerk session, service secret)
- `src/api/middleware/rate-limit.ts` — 60 req/min per agent
- `src/api/routes/agents.ts` — POST/GET/DELETE /agents, PATCH /agents/:id/approval
- `src/api/routes/policies.ts` — POST/GET/PATCH/DELETE /policies, POST /policies/reset
- `src/api/routes/gmail.ts` — POST /gmail/search|read|draft|send|archive|trash, GET /gmail/labels
- `src/api/routes/audit.ts` — GET /audit, GET /audit/:id
- `src/api/routes/grants.ts` — POST/GET/DELETE /grants
- `src/api/__tests__/*.test.ts`

**Auth middleware — three paths:**
1. Agent key: `Authorization: Bearer sma_{key}` → hash key, lookup in agents table → resolve (userId, agentId)
2. User session: Clerk session token → resolve userId (for CLI human use)
3. Service secret: `Authorization: Bearer {mcp-service-secret}` → for MCP→API internal calls

**Gmail route request flow (read path):**
1. Extract agent key from Authorization header
2. Resolve key → (userId, agentId)
3. Check agent not revoked
4. Load active Cedar policies + session grants from PostgreSQL
5. Policy engine early exit: no-action zone active? No matching read policy?
6. Fetch Gmail OAuth token from Clerk (never cached)
7. Forward to Gmail API
8. Extract attributes from results
9. Post-fetch filter: evaluate each result, strip unauthorized
10. Over-fetch up to 3 rounds if filtered count < limit
11. Write audit entry
12. Return filtered results

**Gmail route request flow (write path):**
1-5. Same as read path
6. Classify risk tier: draft/archive/label→medium, send/reply→high, trash/delete→critical
7. Medium: auto-allow + notify. High: create draft + approval. Critical: block + approval.
8. Write audit entry
9. Return result

**Internal routes** (for MCP server): same logic but behind service-secret auth at `/internal/gmail/*`.

## Conventions

- Import shared types from `src/shared/types.ts`
- Import DB schema from `src/db/schema.ts`
- Import config from `src/config/env.ts`
- Use Zod for all input validation on routes
- Tests go in `__tests__/` colocated with source
- Use `bun:test` with describe/it/expect
- Test behavior, not implementation
- Always test fail-closed scenarios (this is security-critical)
- Mock external services (Gmail, Clerk, Anthropic) in tests
