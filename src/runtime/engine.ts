import type {
  CedarAction,
  PolicyDecision,
  GmailMessageAttributes,
  ApplicationSidecar,
  PolicyContext,
} from "@shared/types.ts";
import { PolicyEngine } from "./policy-engine.ts";
import { buildContext } from "./context.ts";
import { createChildLogger } from "@shared/logger.ts";

const log = createChildLogger("runtime:engine");

// ─── Types ──────────────────────────────────────────────────────────────────

export type StoredPolicy = {
  id: string;
  agentId: string | null; // null = applies to all agents
  cedar: string;
  sidecar: ApplicationSidecar;
  enabled: boolean;
  expiresAt: Date | null;
  createdAt: Date;
};

export type EngineSessionGrant = {
  id: string;
  action: CedarAction;
  grantType: "once" | "session";
  consumed: boolean;
};

export type RequestContext = {
  agentId: string;
  agentName: string;
  sessionId: string | null;
  userTimezone: string;
};

export type EvaluationContext = {
  policies: StoredPolicy[];
  sessionGrants: EngineSessionGrant[];
};

export type PermitDecision = {
  effect: "permit";
  matchedPolicies: string[];
  consumeGrantId?: string;
};

export type DenyDecision = {
  effect: "deny";
  reason: string;
};

export type PendingApprovalDecision = {
  effect: "pending_approval";
  approvalId: string;
};

export type EngineDecision = PermitDecision | DenyDecision | PendingApprovalDecision;

// ─── RequestEngine ──────────────────────────────────────────────────────────

export class RequestEngine {
  constructor(private policyEngine: PolicyEngine) {}

  evaluate(
    action: CedarAction,
    resource: GmailMessageAttributes,
    requestContext: RequestContext,
    evalContext: EvaluationContext,
  ): EngineDecision {
    const { agentId, agentName, sessionId, userTimezone } = requestContext;
    const now = new Date();

    // Step 1: Filter expired and disabled policies
    const activePolicies = evalContext.policies.filter((p) => {
      if (!p.enabled) return false;
      if (p.expiresAt && p.expiresAt < now) return false;
      return true;
    });

    // Step 2: Filter to policies relevant to this agent (agent-specific + wildcard)
    const relevantPolicies = activePolicies.filter(
      (p) => p.agentId === null || p.agentId === agentId,
    );

    // Load policies into Cedar engine
    const cedarPolicies = relevantPolicies
      .filter((p) => p.cedar.trim().length > 0)
      .map((p) => ({ id: p.id, cedar: p.cedar }));

    if (cedarPolicies.length > 0) {
      this.policyEngine.loadPolicies(agentId, cedarPolicies);
    } else {
      this.policyEngine.clearPolicies(agentId);
    }

    // Step 3: Check no-action zones
    // A no-action zone is a forbid policy that covers all actions with no attribute conditions
    // (it may have time conditions which are handled by Cedar)
    // We detect this by checking if there's a forbid policy with no conditions
    // and it covers all actions (wildcard) or specifically covers the requested action
    for (const policy of relevantPolicies) {
      if (policy.cedar.trim().length === 0) continue;
      // Check if this is a blanket forbid (noaction generates forbid with all actions, no attribute conditions)
      if (isNoActionZone(policy, action)) {
        // Still evaluate via Cedar to check time conditions
        const ctx = this.buildPolicyContext(policy.createdAt, userTimezone);
        const result = this.policyEngine.evaluate(agentId, agentName, action, resource, ctx);
        if (result.decision === "deny") {
          log.info({ agentId, action, policyId: policy.id }, "No-action zone active — denied");
          return { effect: "deny", reason: "no-action zone active" };
        }
      }
    }

    // Step 4: Check session grants
    if (sessionId) {
      for (const grant of evalContext.sessionGrants) {
        if (grant.action !== action) continue;
        if (grant.consumed) continue;

        if (grant.grantType === "session") {
          log.info({ agentId, action, grantId: grant.id }, "Permitted via session grant");
          return { effect: "permit", matchedPolicies: [], consumeGrantId: undefined };
        }

        if (grant.grantType === "once") {
          log.info({ agentId, action, grantId: grant.id }, "Permitted via one-time grant");
          return { effect: "permit", matchedPolicies: [], consumeGrantId: grant.id };
        }
      }
    }

    // Step 5: Check sidecar approval requirements
    for (const policy of relevantPolicies) {
      if (policy.sidecar.requiresApproval?.includes(action)) {
        log.info({ agentId, action, policyId: policy.id }, "Action requires approval");
        return {
          effect: "pending_approval",
          approvalId: `approval-${policy.id}-${Date.now()}`,
        };
      }
    }

    // Step 6: Evaluate Cedar policies
    if (!this.policyEngine.hasPolicies(agentId)) {
      log.info({ agentId, action }, "No policies loaded — denied");
      return { effect: "deny", reason: "no matching policy" };
    }

    // Build context for the oldest relevant policy (for duration checks)
    // Use the earliest createdAt among active policies
    const oldestPolicy = relevantPolicies.reduce((oldest, p) =>
      p.createdAt < oldest.createdAt ? p : oldest,
    );
    const ctx = this.buildPolicyContext(oldestPolicy.createdAt, userTimezone);

    const result = this.policyEngine.evaluate(agentId, agentName, action, resource, ctx);

    if (result.decision === "allow") {
      log.debug({ agentId, action, policies: result.reasons }, "Permitted by Cedar");
      return { effect: "permit", matchedPolicies: result.reasons };
    }

    log.info({ agentId, action }, "Denied by Cedar — no matching policy");
    return { effect: "deny", reason: "no matching policy" };
  }

  private buildPolicyContext(policyCreatedAt: Date, userTimezone: string): PolicyContext {
    return buildContext({ userTimezone, policyCreatedAt });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isNoActionZone(policy: StoredPolicy, _action: CedarAction): boolean {
  // A no-action zone is identified by its sidecar having no requiresApproval
  // and its Cedar being a blanket forbid covering all actions.
  // We detect this by looking for "forbid(" with "principal," (wildcard) or specific principal
  // and multiple actions or wildcard action
  const cedar = policy.cedar.trim();
  if (!cedar.startsWith("forbid(")) return false;

  // Check if it covers all actions (uses action in [...all actions...] or action,)
  // A noaction policy emitted by the compiler will have all 6 actions listed
  // or no action constraint (just "action,")
  const hasWildcardAction = cedar.includes("\n  action,\n");
  const hasAllActions =
    cedar.includes('"gmail:messages:read"') &&
    cedar.includes('"gmail:messages:list"') &&
    cedar.includes('"gmail:messages:draft"') &&
    cedar.includes('"gmail:messages:send"') &&
    cedar.includes('"gmail:messages:archive"') &&
    cedar.includes('"gmail:messages:trash"');

  // Check no attribute conditions (only time conditions allowed)
  // Attribute conditions reference "resource." — time conditions reference "context."
  const hasAttributeConditions =
    cedar.includes("resource.from") ||
    cedar.includes("resource.to") ||
    cedar.includes("resource.subject") ||
    cedar.includes("resource.labels") ||
    cedar.includes("resource.threadId");

  return (hasWildcardAction || hasAllActions) && !hasAttributeConditions;
}
