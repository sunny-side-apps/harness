<background>
You are an expert TypeScript/Bun developer building the policy runtime engine for Save My Ass — a Cedar-based policy enforcement layer for AI agent Gmail access. Phase 1 (DSL compiler) is complete. You are now building Phase 2: the runtime that evaluates Cedar
policies against live requests with default-deny semantics.

Key constraints:

- Always import Cedar from '@cedar-policy/cedar-wasm/nodejs' (NOT bare import)
- CEDAR_SCHEMA is already exported from 'src/compiler/emitter.ts' — reuse it
- Types are in 'src/shared/types.ts' — do not redefine them
- Use 'src/shared/logger.ts' for logging with createChildLogger
- Tests use bun:test with describe/it/expect
- Fail-closed on every error path: deny, never permit on failure

</background>

<setup>
  1. Read the Phase 2 plan at docs/plans/phase2/PLAN.md to understand full requirements
  2. Read src/shared/types.ts to understand all type definitions (PolicyDecision, PolicyRequest, PolicyContext,
  GmailMessageAttributes, ApplicationSidecar, SessionGrant, CedarAction, etc.)
  3. Read src/compiler/emitter.ts to understand CEDAR_SCHEMA export and how Cedar validation works
  4. Read src/runtime/__tests__/cedar-spike.test.ts to understand the working Cedar WASM pattern (entity format, AuthorizationCall
  structure, isAuthorized usage)
  5. Read src/shared/logger.ts to understand logging conventions (createChildLogger, withMdc)
  6. Read src/db/schema.ts to understand the database schema (policies, sessionGrants tables)
  7. Read src/compiler/errors.ts to understand error class patterns used in the project
  8. Activate the unit-tests skill with /unit-tests for test writing guidance
</setup>

<tasks>

1. Create src/runtime/errors.ts with runtime-specific error classes: PolicyLoadError, PolicyEvaluationError, ContextBuildError, FilterError. Follow the pattern from src/compiler/errors.ts.

2. Create src/runtime/context.ts:
   - Export buildContext(input: { userTimezone: string; policyCreatedAt: Date }): PolicyContext
   - Export buildContextAt(input, now: DateTime): PolicyContext for deterministic testing
   - Use Luxon DateTime for timezone-aware hourOfDay (0-23) and dayOfWeek (1=Mon, 7=Sun)
   - now = Unix timestamp in seconds, grantedAt = policyCreatedAt as Unix seconds

3. Create src/runtime/**tests**/context.test.ts:
   - Test correct now timestamp generation
   - Test hourOfDay in different timezones (e.g. UTC vs America/New_York at the same instant)
   - Test dayOfWeek (Monday=1 through Sunday=7)
   - Test timezone crossing midnight (UTC Wednesday but Tuesday in US Pacific)
   - Test grantedAt matches policy creation time

4. Create src/runtime/policy-engine.ts:
   - Class PolicyEngine with methods: initialize(), loadPolicies(), swapPolicies(), evaluate(), clearPolicies(), hasPolicies()
   - Store policy sets in a Map<string, LoadedPolicySet> keyed by agentId
   - initialize() parses and validates CEDAR_SCHEMA from src/compiler/emitter.ts
   - loadPolicies(agentId, policies: Array<{ id: string; cedar: string }>) concatenates cedar strings, validates against schema,
     stores in map
   - swapPolicies() replaces existing policies atomically (create new set first, then swap reference)
   - evaluate(agentId, agentName, action, resource: GmailMessageAttributes, context: PolicyContext) builds entities array (Agent
     principal + GmailMessage resource with all attrs), calls isAuthorized(), returns EvaluationResult with decision, reasons (policy
     IDs), errors
   - On any Cedar error: return { decision: 'deny', reasons: [], errors: [errorMessage] }
   - On no policies loaded: return { decision: 'deny', reasons: [], errors: ['no_policies_loaded'] }
   - Use createChildLogger('runtime:policy-engine') for logging

5. Create src/runtime/**tests**/policy-engine.test.ts:
   - Test loading policies and verifying they are stored
   - Test permit when policy matches (principal + action + conditions)
   - Test deny when no policy matches (default-deny)
   - Test deny when principal does not match (wrong agent)
   - Test deny when conditions do not match (email from wrong domain)
   - Test forbid wins over permit (deny policy with matching label)
   - Test time-based context conditions (grantedAt + duration > now)
   - Test schedule conditions (dayOfWeek + hourOfDay)
   - Test fail-closed on invalid Cedar policy string
   - Test clearPolicies removes agent policies
   - Test hasPolicies returns correct boolean
   - Test swapPolicies replaces old set
   - Test wildcard principal (no principal constraint) permits any agent
   - Use real Cedar WASM evaluation — no mocking of the policy engine itself

6. Create src/runtime/engine.ts:
   - Class RequestEngine with constructor taking PolicyEngine
   - Main method: evaluate(action, resource, requestContext, evalContext) returning Promise<PolicyDecision>
   - requestContext: { agentId, agentName, sessionId, userTimezone }
   - evalContext: { policies: StoredPolicy[], sessionGrants: SessionGrant[] }
   - StoredPolicy: { id, agentId (null = wildcard), cedar, sidecar: ApplicationSidecar, enabled, expiresAt, createdAt }
   - Step 1: Filter out expired policies (expiresAt !== null && expiresAt < now) and disabled policies (enabled === false)
   - Step 2: Load remaining policies into PolicyEngine via loadPolicies
   - Step 3: Check no-action zones — find deny/noaction policies whose cedar covers all actions for this agent. If the agent+action
     is blocked by a noaction zone, deny immediately with reason 'no-action zone active'
   - Step 4: Check session grants — if action matches a non-consumed grant for this session, return permit. For once grants, flag
     for consumption (do not consume here, caller does that)
   - Step 5: Check sidecar requiresApproval — if any active policy has sidecar.requiresApproval containing the requested action,
     return pending_approval
   - Step 6: Call PolicyEngine.evaluate() with built context
   - Step 7: Map result to PolicyDecision
   - Use createChildLogger('runtime:engine')

7. Create src/runtime/**tests**/engine.test.ts:
   - Test permits when Cedar allows
   - Test denies when no matching policy (default deny)
   - Test denies immediately for no-action zone
   - Test permits via session grant (grantType = 'session')
   - Test permits via one-time grant (grantType = 'once', consumed = false)
   - Test does not permit consumed one-time grant (consumed = true)
   - Test returns pending_approval when sidecar requires approval for action
   - Test filters expired policies (expiresAt in past)
   - Test filters disabled policies
   - Test respects wildcard agent policies (agentId = null)
   - Test includes matched policy IDs in permit decision

8. Create src/runtime/filter.ts:
   - Class PostFetchFilter with constructor taking RequestEngine
   - Method filter(messages: GmailMessage[], action: CedarAction, context: FilterContext, evalContext: EvaluationContext):
     Promise<FilterResult>
   - FilterContext: { agentId, agentName, sessionId, userTimezone, requestedLimit, currentRound }
   - FilterResult: { allowed: GmailMessage[], filteredCount: number, shouldOverfetch: boolean }
   - Extract GmailMessageAttributes from each GmailMessage (id, threadId, from, to, subject, labels, date)
   - Evaluate each message independently via RequestEngine
   - Collect allowed messages, count filtered
   - Set shouldOverfetch = true if allowed.length < requestedLimit AND currentRound < 3
   - Log filtered count at info level (not the message content)
   - Use createChildLogger('runtime:filter')

9. Create src/runtime/**tests**/filter.test.ts:
   - Test allows messages matching policy
   - Test filters messages not matching policy
   - Test signals over-fetch when count below limit (round 0)
   - Test does not signal over-fetch on round 3 (max reached)
   - Test handles empty message list
   - Test handles all messages filtered (returns empty, shouldOverfetch true if round < 3)
   - Test evaluates each message independently

10. Create src/runtime/**tests**/integration.test.ts with end-to-end scenarios: - Basic allow (openclaw reads team emails) - Deny by no policy match (wrong label) - No-action zone blocks everything - Forbid wins over permit (auth label deny) - Time-based expiry (policy expired by duration) - Schedule-based access (weekend denied during weekdays policy) - Session grant permits action - One-time grant permits then flags consumed - Post-fetch filtering (mixed results, only matching pass through) - Pending approval for restricted action - Each scenario compiles a real DSL string through the compiler, then evaluates through the runtime

</tasks>

<testing>
  1. Run bun test src/runtime/__tests__/context.test.ts and verify all pass
  2. Run bun test src/runtime/__tests__/policy-engine.test.ts and verify all pass
  3. Run bun test src/runtime/__tests__/engine.test.ts and verify all pass
  4. Run bun test src/runtime/__tests__/filter.test.ts and verify all pass
  5. Run bun test src/runtime/__tests__/integration.test.ts and verify all pass
  6. Run bun test src/runtime to verify all runtime tests pass together
  7. Run bun test to verify no regressions in Phase 1 compiler tests
</testing>

Output <promise>COMPLETE</promise> when all tasks are done.
