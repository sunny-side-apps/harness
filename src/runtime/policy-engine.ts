import type { CedarAction, PolicyContext, GmailMessageAttributes } from "@shared/types.ts";
import {
  isAuthorized,
  validate,
  type AuthorizationCall,
  type Schema,
  type ValidationCall,
} from "@cedar-policy/cedar-wasm/nodejs";
import { CEDAR_SCHEMA } from "@compiler/emitter.ts";
import { PolicyLoadError, PolicyEvaluationError } from "./errors.ts";
import { createChildLogger } from "@shared/logger.ts";

const log = createChildLogger("runtime:policy-engine");

// ─── Types ──────────────────────────────────────────────────────────────────

export type CedarDecision = "allow" | "deny";

export type EvaluationResult = {
  decision: CedarDecision;
  reasons: string[];
  errors: string[];
};

export type LoadedPolicySet = {
  cedar: string;
  policyIds: string[];
  loadedAt: number;
};

// ─── PolicyEngine ───────────────────────────────────────────────────────────

export class PolicyEngine {
  private schema: Schema;
  private policySets: Map<string, LoadedPolicySet> = new Map();

  constructor() {
    this.schema = CEDAR_SCHEMA;
  }

  initialize(): void {
    const call: ValidationCall = {
      validationSettings: { mode: "strict" },
      schema: this.schema,
      policies: { staticPolicies: "", templates: {}, templateLinks: [] },
    };
    const result = validate(call);
    if (result.type === "failure") {
      throw new PolicyLoadError("Failed to initialize Cedar schema: " + result.errors.map((e) => e.message).join("; "));
    }
    log.info("Cedar schema initialized");
  }

  loadPolicies(agentId: string, policies: Array<{ id: string; cedar: string }>): void {
    const nonEmpty = policies.filter((p) => p.cedar.trim().length > 0);
    if (nonEmpty.length === 0) {
      this.policySets.delete(agentId);
      return;
    }

    const combinedCedar = nonEmpty.map((p) => p.cedar).join("\n");
    const policyIds = nonEmpty.map((p) => p.id);

    // Validate combined policy set
    const call: ValidationCall = {
      validationSettings: { mode: "strict" },
      schema: this.schema,
      policies: { staticPolicies: combinedCedar, templates: {}, templateLinks: [] },
    };
    const result = validate(call);

    if (result.type === "failure") {
      throw new PolicyLoadError(
        `Failed to load policies for agent ${agentId}: ${result.errors.map((e) => e.message).join("; ")}`,
        agentId,
      );
    }

    if (result.type === "success" && result.validationErrors.length > 0) {
      throw new PolicyLoadError(
        `Policy validation errors for agent ${agentId}: ${result.validationErrors.map((e) => e.error.message).join("; ")}`,
        agentId,
      );
    }

    this.policySets.set(agentId, {
      cedar: combinedCedar,
      policyIds,
      loadedAt: Math.floor(Date.now() / 1000),
    });

    log.debug({ agentId, policyCount: nonEmpty.length }, "Policies loaded");
  }

  swapPolicies(agentId: string, policies: Array<{ id: string; cedar: string }>): void {
    const nonEmpty = policies.filter((p) => p.cedar.trim().length > 0);
    if (nonEmpty.length === 0) {
      this.policySets.delete(agentId);
      return;
    }

    const combinedCedar = nonEmpty.map((p) => p.cedar).join("\n");
    const policyIds = nonEmpty.map((p) => p.id);

    // Validate new set first before swapping
    const call: ValidationCall = {
      validationSettings: { mode: "strict" },
      schema: this.schema,
      policies: { staticPolicies: combinedCedar, templates: {}, templateLinks: [] },
    };
    const result = validate(call);

    if (result.type === "failure") {
      // Keep the old policy set — don't swap
      log.error({ agentId, errors: result.errors }, "Policy swap rejected: validation failed");
      throw new PolicyLoadError(
        `Policy swap rejected for agent ${agentId}: ${result.errors.map((e) => e.message).join("; ")}`,
        agentId,
      );
    }

    if (result.type === "success" && result.validationErrors.length > 0) {
      log.error({ agentId, errors: result.validationErrors }, "Policy swap rejected: validation errors");
      throw new PolicyLoadError(
        `Policy swap rejected for agent ${agentId}: ${result.validationErrors.map((e) => e.error.message).join("; ")}`,
        agentId,
      );
    }

    // Atomic swap: create new set, then replace reference
    const newSet: LoadedPolicySet = {
      cedar: combinedCedar,
      policyIds,
      loadedAt: Math.floor(Date.now() / 1000),
    };
    this.policySets.set(agentId, newSet);

    log.debug({ agentId, policyCount: nonEmpty.length }, "Policies swapped");
  }

  evaluate(
    agentId: string,
    agentName: string,
    action: CedarAction,
    resource: GmailMessageAttributes,
    context: PolicyContext,
  ): EvaluationResult {
    const policySet = this.policySets.get(agentId);
    if (!policySet) {
      return { decision: "deny", reasons: [], errors: ["no_policies_loaded"] };
    }

    try {
      const call: AuthorizationCall = {
        principal: { type: "AgentGate::Agent", id: agentName },
        action: { type: "AgentGate::Action", id: action },
        resource: { type: "AgentGate::GmailMessage", id: resource.id },
        context,
        schema: this.schema,
        policies: {
          staticPolicies: policySet.cedar,
          templates: {},
          templateLinks: [],
        },
        entities: [
          {
            uid: { type: "AgentGate::Agent", id: agentName },
            attrs: {},
            parents: [],
          },
          {
            uid: { type: "AgentGate::GmailMessage", id: resource.id },
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
      };

      const result = isAuthorized(call);

      if (result.type === "failure") {
        log.error(
          { agentId, action, errors: result.errors },
          "Cedar authorization call failed",
        );
        return {
          decision: "deny",
          reasons: [],
          errors: result.errors.map((e) => e.message),
        };
      }

      const decision: CedarDecision =
        result.response.decision === "allow" ? "allow" : "deny";

      return {
        decision,
        reasons: policySet.policyIds,
        errors: [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { agentId, action, error: message },
        "Cedar evaluation threw — failing closed",
      );
      return {
        decision: "deny",
        reasons: [],
        errors: [message],
      };
    }
  }

  clearPolicies(agentId: string): void {
    this.policySets.delete(agentId);
    log.debug({ agentId }, "Policies cleared");
  }

  hasPolicies(agentId: string): boolean {
    return this.policySets.has(agentId);
  }
}
