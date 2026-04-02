import type { ResolvedPolicyAST, CedarAction } from "@shared/types.ts";
import type { ConflictIssue } from "./errors.ts";
import { ConflictError } from "./errors.ts";

type ExistingPolicy = {
  id: string;
  ast: ResolvedPolicyAST;
};

export type ConflictCheckResult = {
  errors: ConflictIssue[];
  warnings: ConflictIssue[];
};

export function checkConflicts(
  newPolicy: ResolvedPolicyAST,
  existingPolicies: ExistingPolicy[],
): ConflictCheckResult {
  const errors: ConflictIssue[] = [];
  const warnings: ConflictIssue[] = [];

  for (const existing of existingPolicies) {
    // Check shadowed allows: new allow is shadowed by existing deny
    if (newPolicy.kind === "allow" && (existing.ast.kind === "deny" || existing.ast.kind === "noaction")) {
      if (policyShadows(existing.ast, newPolicy)) {
        errors.push({
          severity: "error",
          code: "SHADOWED_ALLOW",
          message: `This allow rule is shadowed by existing deny policy '${existing.id}'. The allow will never take effect because deny always wins.`,
          existingPolicyId: existing.id,
        });
      }
    }

    // Check redundant rules: new policy is already covered by an existing one
    if (newPolicy.kind === existing.ast.kind) {
      if (policySubsumedBy(newPolicy, existing.ast)) {
        warnings.push({
          severity: "warning",
          code: "REDUNDANT_RULE",
          message: `This rule is already covered by existing policy '${existing.id}'.`,
          existingPolicyId: existing.id,
        });
      }
    }
  }

  if (errors.length > 0) {
    throw new ConflictError(
      `Policy conflicts detected: ${errors.length} error(s)`,
      [...errors, ...warnings],
    );
  }

  return { errors, warnings };
}

/**
 * Returns true if `deny` shadows `allow` — the deny covers everything the allow permits.
 * A deny shadows an allow when:
 * 1. The deny's agent covers the allow's agent (same agent or wildcard)
 * 2. The deny's operations cover the allow's operations
 * 3. The deny has no conditions (unconditional) OR has a subset of conditions
 * 4. The deny has no time bound (permanent) or a broader time bound
 */
function policyShadows(deny: ResolvedPolicyAST, allow: ResolvedPolicyAST): boolean {
  // Agent coverage: deny covers allow if deny is wildcard or same agent
  if (!agentCovers(deny.agent, allow.agent)) return false;

  // Operation coverage: deny covers all of allow's operations
  if (!operationsCovers(deny.operations, allow.operations)) return false;

  // Resource must match
  if (deny.resource.service !== allow.resource.service ||
      deny.resource.type !== allow.resource.type) return false;

  // If deny has no conditions, it's unconditional → shadows everything
  if (!deny.conditions || deny.conditions.length === 0) {
    // If deny has no time bound, it's permanent → definitely shadows
    if (!deny.timeBound) return true;
    // If deny has a time bound but allow doesn't, deny is narrower → doesn't shadow
    if (!allow.timeBound) return false;
    // Both have time bounds — conservatively say it shadows (could be refined)
    return true;
  }

  // If deny has conditions, it only shadows if conditions match exactly
  // (Conservative: we only detect exact condition match)
  if (!allow.conditions) return false;
  return conditionsMatch(deny.conditions, allow.conditions);
}

/**
 * Returns true if `newPolicy` is subsumed by `existing` (same effect, existing covers new).
 */
function policySubsumedBy(newPolicy: ResolvedPolicyAST, existing: ResolvedPolicyAST): boolean {
  if (!agentCovers(existing.agent, newPolicy.agent)) return false;
  if (!operationsCovers(existing.operations, newPolicy.operations)) return false;
  if (existing.resource.service !== newPolicy.resource.service ||
      existing.resource.type !== newPolicy.resource.type) return false;

  // Existing must be at least as broad (no conditions, or matching conditions)
  if (existing.conditions && existing.conditions.length > 0) {
    if (!newPolicy.conditions) return false;
    if (!conditionsMatch(existing.conditions, newPolicy.conditions)) return false;
  }

  return true;
}

function agentCovers(broader: string | "*", narrower: string | "*"): boolean {
  if (broader === "*") return true;
  return broader === narrower;
}

function operationsCovers(broader: CedarAction[], narrower: CedarAction[]): boolean {
  const broaderSet = new Set(broader);
  return narrower.every((op) => broaderSet.has(op));
}

function conditionsMatch(a: readonly { attribute: string; operator: string; value: unknown }[], b: readonly { attribute: string; operator: string; value: unknown }[]): boolean {
  if (a.length !== b.length) return false;
  for (const condA of a) {
    const found = b.some(
      (condB) =>
        condA.attribute === condB.attribute &&
        condA.operator === condB.operator &&
        JSON.stringify(condA.value) === JSON.stringify(condB.value),
    );
    if (!found) return false;
  }
  return true;
}
