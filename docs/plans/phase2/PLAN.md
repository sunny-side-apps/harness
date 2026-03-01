# Phase 2 — Policy Runtime Engine

**Goal:** Evaluate Cedar policies against live requests with default-deny semantics.

**Prerequisites:** Phase 1 (DSL Compiler) completed. Cedar WASM validated in `src/runtime/__tests__/cedar-spike.test.ts`.

---

## Overview

The policy runtime engine is the enforcement point for all agent requests. It sits between the API server and Gmail, evaluating every operation against the compiled Cedar policies stored in PostgreSQL.

**Key principles:**
- **Default-deny:** No matching policy = deny
- **Fail-closed:** Any error = deny + log
- **Invisible filtering:** Agents never know what was filtered out
- **Atomic swaps:** Policy updates do not affect in-flight requests

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/runtime/policy-engine.ts` | Cedar WASM wrapper, policy loading, atomic swap |
| `src/runtime/engine.ts` | Request orchestrator: no-action → sidecar → Cedar |
| `src/runtime/context.ts` | Build Cedar context (now, grantedAt, hourOfDay, dayOfWeek) |
| `src/runtime/filter.ts` | Post-fetch filter for read operations |
| `src/runtime/__tests__/policy-engine.test.ts` | PolicyEngine unit tests |
| `src/runtime/__tests__/engine.test.ts` | RequestEngine integration tests |
| `src/runtime/__tests__/context.test.ts` | Context builder tests |
| `src/runtime/__tests__/filter.test.ts` | Post-fetch filter tests |

---

## 2.1 Policy Engine (`src/runtime/policy-engine.ts`)

Wraps `@cedar-policy/cedar-wasm/nodejs` and manages policy sets per agent.

### Interface

```typescript
import type { CedarAction, PolicyContext, GmailMessageAttributes } from '@shared/types.ts';

type CedarDecision = 'allow' | 'deny';

type EvaluationResult = {
  decision: CedarDecision;
  reasons: string[];      // Policy IDs that matched (for audit)
  errors: string[];       // If Cedar threw, captured here
};

type LoadedPolicySet = {
  cedar: string;          // Combined Cedar policies
  policyIds: string[];    // Source policy UUIDs for audit
  loadedAt: number;       // Unix timestamp
};

class PolicyEngine {
  constructor();

  // Load Cedar schema once at startup
  initialize(): void;

  // Load policy set for an agent from compiled Cedar strings
  loadPolicies(agentId: string, policies: Array<{ id: string; cedar: string }>): void;

  // Atomic swap: replace agent's policy set
  swapPolicies(agentId: string, policies: Array<{ id: string; cedar: string }>): void;

  // Evaluate a single request
  evaluate(
    agentId: string,
    agentName: string,
    action: CedarAction,
    resource: GmailMessageAttributes,
    context: PolicyContext,
  ): EvaluationResult;

  // Clear policies for an agent (on agent revocation)
  clearPolicies(agentId: string): void;

  // Check if any policies are loaded for an agent
  hasPolicies(agentId: string): boolean;
}
```

### Behavior

1. **Initialization:**
   - Parse and validate `CEDAR_SCHEMA` (exported from `src/compiler/emitter.ts`) once
   - Store the validated schema in memory

2. **Policy Loading:**
   - Combine multiple Cedar policy strings into a single policy set
   - Validate the combined set against the schema
   - Store in an in-memory Map keyed by agentId
   - Track policy IDs for audit trail

3. **Evaluation:**
   - Build Cedar entities: Agent (principal) + GmailMessage (resource)
   - Build Cedar request with action and context
   - Call `isAuthorized()` from cedar-wasm
   - Map Cedar response to `EvaluationResult`

4. **Failure modes:**
   - Cedar throws → return `{ decision: 'deny', reasons: [], errors: [errorMessage] }`
   - No policies loaded → return `{ decision: 'deny', reasons: [], errors: ['no_policies_loaded'] }`

### Cedar Entity Format

Reference the working pattern from `cedar-spike.test.ts`:

```typescript
entities: [
  {
    uid: { type: 'AgentGate::Agent', id: agentName },
    attrs: {},
    parents: [],
  },
  {
    uid: { type: 'AgentGate::GmailMessage', id: resource.id },
    attrs: {
      from: resource.from,
      to: resource.to,
      subject: resource.subject,
      labels: resource.labels,
      date: resource.date,
      threadId: resource.threadId,
    },
    parents: [],
  },
],
```

### Tests

- `loads policies successfully` — verify policy set is stored
- `evaluates permit when policy matches` — matching principal + action + conditions
- `evaluates deny when no policy matches` — default-deny behavior
- `evaluates deny when principal does not match` — wrong agent
- `evaluates deny when conditions do not match` — email attributes fail conditions
- `forbid policy wins over permit` — Cedar forbid semantics
- `handles time-based conditions` — grantedAt, now, hourOfDay, dayOfWeek
- `fails closed on Cedar error` — corrupted policy → deny
- `atomic swap does not affect in-flight evaluation` — concurrent safety
- `returns matching policy IDs for audit` — reasons array populated
- `clearPolicies removes agent policies` — revocation scenario

---

## 2.2 Request Engine (`src/runtime/engine.ts`)

Orchestrates the full evaluation flow for a single request.

### Interface

```typescript
import type {
  CedarAction,
  PolicyDecision,
  GmailMessageAttributes,
  ApplicationSidecar,
} from '@shared/types.ts';

type StoredPolicy = {
  id: string;
  agentId: string | null;  // null = applies to all agents
  cedar: string;
  sidecar: ApplicationSidecar;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
};

type SessionGrant = {
  id: string;
  action: CedarAction;
  grantType: 'once' | 'session';
  consumed: boolean;
};

type RequestContext = {
  agentId: string;
  agentName: string;
  sessionId: string | null;
  userTimezone: string;  // IANA timezone, e.g. 'America/New_York'
};

type EvaluationContext = {
  policies: StoredPolicy[];
  sessionGrants: SessionGrant[];
};

class RequestEngine {
  constructor(policyEngine: PolicyEngine);

  // Main entry point: evaluate a request
  evaluate(
    action: CedarAction,
    resource: GmailMessageAttributes,
    requestContext: RequestContext,
    evalContext: EvaluationContext,
  ): Promise<PolicyDecision>;

  // Consume a one-time grant (after successful execution)
  consumeGrant(grantId: string): Promise<void>;
}
```

### Evaluation Flow

```
1. Filter expired policies (expiresAt < now)
2. Filter disabled policies (enabled = false)
3. Load remaining policies into PolicyEngine

4. Check no-action zones:
   - Find noaction/deny policies with no conditions or only time conditions
   - If any match this agent + action → deny immediately

5. Check sidecar: session grants
   - If action matches a session grant for this session → permit
   - If action matches a one-time grant (not consumed) → permit (mark for consumption)

6. Check sidecar: approval requirements
   - If action requires approval per sidecar → return pending_approval

7. Evaluate Cedar policy engine
   - Build context using ContextBuilder
   - Call PolicyEngine.evaluate()
   - Return permit/deny based on result

8. Return PolicyDecision with matched policy IDs
```

### PolicyDecision Mapping

```typescript
// From shared/types.ts
type PolicyDecision =
  | { effect: 'permit' }
  | { effect: 'deny'; reason: string }
  | { effect: 'pending_approval'; approvalId: string };
```

### Tests

- `permits when Cedar allows` — straightforward allow policy
- `denies when Cedar denies` — no matching policy
- `denies immediately for no-action zone` — noaction policy active
- `permits via session grant` — grant type = session
- `permits via one-time grant and marks consumed` — grant type = once
- `returns pending_approval when sidecar requires it` — requiresApproval in sidecar
- `filters expired policies` — expiresAt in past
- `filters disabled policies` — enabled = false
- `includes matched policy IDs in decision` — for audit
- `handles concurrent evaluations` — thread safety
- `respects agent-specific vs wildcard policies` — agentId null applies to all

---

## 2.3 Context Builder (`src/runtime/context.ts`)

Builds the Cedar context object with time-aware fields.

### Interface

```typescript
import type { PolicyContext } from '@shared/types.ts';
import { DateTime } from 'luxon';

type ContextInput = {
  userTimezone: string;    // IANA timezone
  policyCreatedAt: Date;   // When the policy was created (for duration bounds)
};

function buildContext(input: ContextInput): PolicyContext;

// Helper for tests
function buildContextAt(input: ContextInput, now: DateTime): PolicyContext;
```

### Implementation

```typescript
function buildContext(input: ContextInput): PolicyContext {
  return buildContextAt(input, DateTime.now());
}

function buildContextAt(input: ContextInput, now: DateTime): PolicyContext {
  const userNow = now.setZone(input.userTimezone);

  return {
    now: Math.floor(now.toSeconds()),                    // Unix timestamp
    grantedAt: Math.floor(input.policyCreatedAt.getTime() / 1000),
    hourOfDay: userNow.hour,                             // 0-23 in user's timezone
    dayOfWeek: userNow.weekday,                          // 1=Mon, 7=Sun (ISO)
  };
}
```

### Key Details

- **Timezone handling:** `hourOfDay` and `dayOfWeek` are computed in the user's local timezone (not UTC). This ensures `during weekdays(9, 17)` means 9am-5pm in the user's timezone.
- **grantedAt:** Comes from the policy's `createdAt` field. Used for duration-based expiry (`for 2h` → `context.grantedAt + 7200 > context.now`).
- **now:** Unix timestamp at evaluation time.

### Tests

- `builds context with correct now timestamp`
- `computes hourOfDay in user timezone` — test with different timezones
- `computes dayOfWeek correctly` — Monday=1, Sunday=7
- `handles timezone crossing midnight` — UTC vs local day
- `handles DST transitions` — spring forward/fall back
- `grantedAt matches policy creation time`

---

## 2.4 Post-Fetch Filter (`src/runtime/filter.ts`)

Filters Gmail messages after fetching, removing any the agent is not authorized to see.

### Interface

```typescript
import type { GmailMessage, GmailMessageAttributes, CedarAction } from '@shared/types.ts';

type FilterResult = {
  allowed: GmailMessage[];
  filteredCount: number;
  shouldOverfetch: boolean;  // True if we need to fetch more to fill the page
};

type FilterContext = {
  agentId: string;
  agentName: string;
  sessionId: string | null;
  userTimezone: string;
  requestedLimit: number;
  currentRound: number;      // 0, 1, 2 — max 3 rounds
};

class PostFetchFilter {
  constructor(requestEngine: RequestEngine);

  // Filter a batch of messages
  filter(
    messages: GmailMessage[],
    action: CedarAction,       // Typically 'gmail:messages:read' or 'gmail:messages:list'
    context: FilterContext,
    evalContext: EvaluationContext,
  ): Promise<FilterResult>;
}
```

### Attribute Extraction

Extract `GmailMessageAttributes` from `GmailMessage`:

```typescript
function extractAttributes(msg: GmailMessage): GmailMessageAttributes {
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    labels: msg.labels,
    date: msg.date,
  };
}
```

### Over-Fetch Logic

1. After filtering, if `allowed.length < requestedLimit` and `currentRound < 3`:
   - Set `shouldOverfetch = true`
   - Caller fetches next page and calls filter again with `currentRound + 1`
2. After 3 rounds, stop over-fetching regardless of count
3. This prevents excessive API calls while still filling pages when possible

### Tests

- `allows messages that match policy` — straightforward permit
- `filters messages that do not match policy` — invisible removal
- `extracts attributes correctly from GmailMessage`
- `signals over-fetch when filtered count below limit` — round 0
- `stops over-fetching after 3 rounds`
- `handles empty message list`
- `handles all messages filtered` — complete block
- `evaluates each message independently` — one denied does not affect others
- `respects action type` — list vs read
- `logs filtered message count for audit` — observability

---

## Integration Test Scenarios

Create `src/runtime/__tests__/integration.test.ts` with end-to-end scenarios:

### Scenario 1: Basic Allow

```
Policy: allow "openclaw" to [read, list] on gmail.messages where { from: "*@team.com" }
Agent: openclaw
Message: { from: "alice@team.com", ... }
Expected: permit
```

### Scenario 2: Deny by No Policy Match

```
Policy: allow "openclaw" to [read] on gmail.messages where { labels contains "work" }
Agent: openclaw
Message: { labels: ["personal"], ... }
Expected: deny
```

### Scenario 3: No-Action Zone

```
Policy: noaction * on gmail.messages for 2h
Agent: any
Message: any
Expected: deny (no-action zone active)
```

### Scenario 4: Forbid Wins

```
Policy 1: allow "openclaw" to [read] on gmail.messages
Policy 2: deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }
Agent: openclaw
Message: { labels: ["sma/class/auth"], ... }
Expected: deny (forbid wins)
```

### Scenario 5: Time-Based Expiry

```
Policy: allow "openclaw" to [read] on gmail.messages for 2h
Agent: openclaw
Context: grantedAt = 3 hours ago
Expected: deny (expired)
```

### Scenario 6: Schedule-Based Access

```
Policy: allow "openclaw" to [read] on gmail.messages during weekdays(9, 17)
Agent: openclaw
Context: Saturday 10am
Expected: deny (not a weekday)
```

### Scenario 7: Session Grant

```
Grant: { action: "gmail:messages:archive", grantType: "session", consumed: false }
Agent: openclaw (in active session)
Expected: permit
```

### Scenario 8: One-Time Grant Consumption

```
Grant: { action: "gmail:messages:trash", grantType: "once", consumed: false }
Agent: openclaw
Expected: permit (first use), then mark consumed
Next request same action: deny (grant consumed)
```

### Scenario 9: Post-Fetch Filtering

```
Policy: allow "openclaw" to [read] on gmail.messages where { from: "*@team.com" }
Agent: openclaw
Messages: [{ from: "alice@team.com" }, { from: "bob@external.com" }, { from: "carol@team.com" }]
Expected: [{ from: "alice@team.com" }, { from: "carol@team.com" }] — bob filtered out
```

### Scenario 10: Pending Approval

```
Policy: allow "openclaw" to [read, archive] on gmail.messages requires approval for [archive]
Agent: openclaw
Action: archive
Expected: pending_approval
```

---

## Implementation Order

1. **context.ts** — Standalone, no dependencies (Day 1 morning)
2. **policy-engine.ts** — Depends on types + Cedar (Day 1 afternoon)
3. **engine.ts** — Depends on policy-engine + context (Day 2)
4. **filter.ts** — Depends on engine (Day 2 afternoon)
5. **Integration tests** — After all components (Day 3)

---

## Dependencies

Existing (no new installs needed):
- `@cedar-policy/cedar-wasm` — already installed and working
- `luxon` — already in package.json

Imports:
- `CEDAR_SCHEMA` from `src/compiler/emitter.ts`
- Types from `src/shared/types.ts`
- Logger from `src/shared/logger.ts`

---

## Conventions

- **Import Cedar from `/nodejs`:** Always use `@cedar-policy/cedar-wasm/nodejs`
- **Logging:** Use `createChildLogger('runtime:policy-engine')` etc.
- **Errors:** Create runtime-specific errors in `src/runtime/errors.ts`
- **Tests:** Colocate in `__tests__/`, use `bun:test`, test behavior not implementation
- **Fail-closed:** Every catch block must deny, not permit

---

## Exit Criteria

Phase 2 is complete when:

1. All four source files exist with full implementations
2. All unit tests pass
3. All integration test scenarios pass
4. `bun test src/runtime` passes with no failures
5. The policy engine correctly:
   - Loads and evaluates Cedar policies
   - Handles all failure modes (fail-closed)
   - Supports atomic policy swaps
   - Respects time-based conditions
   - Filters post-fetch results
   - Tracks matched policies for audit

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Cedar WASM threading issues | PolicyEngine uses synchronous evaluation; no async in hot path |
| Timezone bugs | Comprehensive Luxon tests with fixed time injection |
| Race conditions on policy swap | Use atomic map operations; old set stays valid until swap completes |
| Memory pressure from policy sets | Cap number of cached agents; LRU eviction if needed (defer to Phase 4) |
| Over-fetch loops | Hard cap at 3 rounds; circuit breaker pattern |
