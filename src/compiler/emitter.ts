import type {
  ResolvedPolicyAST,
  ResolvedCondition,
  CedarAction,
  ApplicationSidecar,
  CompileResult,
  TimeBound,
} from "@shared/types.ts";
import {
  validate as cedarValidate,
  type Schema,
  type ValidationCall,
} from "@cedar-policy/cedar-wasm/nodejs";
import { EmitError, ValidationError } from "./errors.ts";

// ─── Cedar Schema (JSON format) ─────────────────────────────────────────────

const CONTEXT_SHAPE = {
  type: "Record" as const,
  attributes: {
    now: { type: "Long" as const },
    grantedAt: { type: "Long" as const },
    hourOfDay: { type: "Long" as const },
    dayOfWeek: { type: "Long" as const },
  },
};

const GMAIL_ACTION_APPLIES_TO = {
  principalTypes: ["Agent"],
  resourceTypes: ["GmailMessage"],
  context: CONTEXT_SHAPE,
};

export const CEDAR_SCHEMA: Schema = {
  AgentGate: {
    entityTypes: {
      Agent: {},
      GmailMessage: {
        shape: {
          type: "Record",
          attributes: {
            from: { type: "String" },
            to: { type: "Set", element: { type: "String" } },
            subject: { type: "String" },
            labels: { type: "Set", element: { type: "String" } },
            date: { type: "Long" },
            threadId: { type: "String" },
          },
        },
      },
      GmailThread: {
        shape: {
          type: "Record",
          attributes: {
            from: { type: "Set", element: { type: "String" } },
            subject: { type: "String" },
            labels: { type: "Set", element: { type: "String" } },
            date: { type: "Long" },
          },
        },
      },
    },
    actions: {
      "gmail:messages:read": { appliesTo: GMAIL_ACTION_APPLIES_TO },
      "gmail:messages:list": { appliesTo: GMAIL_ACTION_APPLIES_TO },
      "gmail:messages:draft": { appliesTo: GMAIL_ACTION_APPLIES_TO },
      "gmail:messages:send": { appliesTo: GMAIL_ACTION_APPLIES_TO },
      "gmail:messages:archive": { appliesTo: GMAIL_ACTION_APPLIES_TO },
      "gmail:messages:trash": { appliesTo: GMAIL_ACTION_APPLIES_TO },
    },
  },
};

// ─── Emitter ─────────────────────────────────────────────────────────────────

export function emit(ast: ResolvedPolicyAST): { cedar: string; sidecar: ApplicationSidecar } {
  const sidecar = extractSidecar(ast);
  const cedarActions = getCedarActions(ast, sidecar);

  // If all operations are handled by sidecar (approval-only), we may still need Cedar for non-approval ops
  if (cedarActions.length === 0 && ast.kind === "allow") {
    // All ops require approval — no Cedar policy needed, sidecar handles everything
    return { cedar: "", sidecar };
  }

  const effect = ast.kind === "allow" ? "permit" : "forbid";
  const principal = emitPrincipal(ast.agent);
  const action = emitAction(cedarActions);
  const resource = emitResource(ast.resource);
  const conditions = emitConditions(ast);

  let cedar = `${effect}(\n  ${principal},\n  ${action},\n  ${resource}\n)`;
  if (conditions) {
    cedar += ` when {\n  ${conditions}\n}`;
  }
  cedar += ";";

  return { cedar, sidecar };
}

function extractSidecar(ast: ResolvedPolicyAST): ApplicationSidecar {
  const sidecar: ApplicationSidecar = {};

  if (ast.requiresApproval) {
    sidecar.requiresApproval = ast.requiresApproval.operations;
  }

  if (ast.timeBound?.kind === "session") {
    sidecar.sessionScoped = true;
  }

  return sidecar;
}

/**
 * Returns the Cedar actions to emit. If `requiresApproval` is set,
 * those actions are handled by the sidecar and excluded from Cedar
 * (unless the rule is deny/noaction).
 */
function getCedarActions(ast: ResolvedPolicyAST, sidecar: ApplicationSidecar): CedarAction[] {
  if (ast.kind !== "allow" || !sidecar.requiresApproval) {
    return ast.operations;
  }

  const approvalSet = new Set(sidecar.requiresApproval);
  return ast.operations.filter((op) => !approvalSet.has(op));
}

function emitPrincipal(agent: string | "*"): string {
  if (agent === "*") return "principal";
  return `principal == AgentGate::Agent::"${agent}"`;
}

function emitAction(actions: CedarAction[]): string {
  if (actions.length === 1) {
    return `action == AgentGate::Action::"${actions[0]}"`;
  }
  const actionList = actions
    .map((a) => `AgentGate::Action::"${a}"`)
    .join(",\n    ");
  return `action in [\n    ${actionList}\n  ]`;
}

function emitResource(resource: { service: string; type: string }): string {
  const entityType = resource.type === "messages" ? "GmailMessage" : "GmailThread";
  return `resource is AgentGate::${entityType}`;
}

function emitConditions(ast: ResolvedPolicyAST): string | null {
  const parts: string[] = [];

  // Attribute conditions from where clause
  if (ast.conditions) {
    for (const cond of ast.conditions) {
      parts.push(emitCondition(cond));
    }
  }

  // Time bound conditions (except session, which is sidecar-only)
  if (ast.timeBound && ast.timeBound.kind !== "session") {
    parts.push(...emitTimeBound(ast.timeBound));
  }

  if (parts.length === 0) return null;
  return parts.join(" &&\n  ");
}

function emitCondition(cond: ResolvedCondition): string {
  const { attribute, operator, value } = cond;
  const ref = `resource.${attribute}`;

  switch (operator) {
    case "==": return `${ref} == ${emitValue(value)}`;
    case "!=": return `${ref} != ${emitValue(value)}`;
    case "like": return `${ref} like ${emitValue(value)}`;
    case "startsWith": return `${ref} like "${value}*"`;
    case "endsWith": return `${ref} like "*${value}"`;
    case "contains": return `${ref}.contains(${emitValue(value)})`;
    case "containsAny": return `${ref}.containsAny(${emitSetValue(value as string[])})`;
    case "containsAll": return `${ref}.containsAll(${emitSetValue(value as string[])})`;
    case "isEmpty": return `${ref} == Set([])`;
    case ">": return `${ref} > ${emitValue(value)}`;
    case "<": return `${ref} < ${emitValue(value)}`;
    case ">=": return `${ref} >= ${emitValue(value)}`;
    case "<=": return `${ref} <= ${emitValue(value)}`;
    default: throw new EmitError(`Unknown operator '${operator}'`);
  }
}

function emitTimeBound(tb: TimeBound): string[] {
  switch (tb.kind) {
    case "duration":
      return [`context.grantedAt + ${tb.seconds} > context.now`];

    case "until": {
      const unix = Math.floor(new Date(tb.timestamp).getTime() / 1000);
      return [`context.now < ${unix}`];
    }

    case "schedule": {
      const parts: string[] = [];
      const { days, startHour, endHour } = tb.schedule;

      if (days === "weekdays") {
        parts.push("context.dayOfWeek >= 1 && context.dayOfWeek <= 5");
      } else if (days === "weekends") {
        parts.push("(context.dayOfWeek == 6 || context.dayOfWeek == 7)");
      }
      // "everyday" has no dayOfWeek constraint

      if (startHour !== 0 || endHour !== 24) {
        parts.push(`context.hourOfDay >= ${startHour} && context.hourOfDay < ${endHour}`);
      }

      return parts;
    }

    case "session":
      return []; // Handled by sidecar
  }
}

function emitValue(value: string | string[] | number | boolean): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function emitSetValue(values: string[]): string {
  const items = values.map((v) => `"${v}"`).join(", ");
  return `[${items}]`;
}

// ─── Cedar Validation ────────────────────────────────────────────────────────

export function validateCedar(cedar: string): void {
  if (!cedar) return; // Empty cedar (all ops handled by sidecar)

  const call: ValidationCall = {
    validationSettings: { mode: "strict" },
    schema: CEDAR_SCHEMA,
    policies: { staticPolicies: cedar, templates: {}, templateLinks: [] },
  };

  const result = cedarValidate(call);

  if (result.type === "failure") {
    const errors = result.errors.map((e) => e.message);
    throw new ValidationError(
      `Cedar validation failed: ${errors.join("; ")}`,
      errors,
    );
  }

  if (result.type === "success" && result.validationErrors.length > 0) {
    const errors = result.validationErrors.map((e) => e.error.message);
    throw new ValidationError(
      `Cedar validation errors: ${errors.join("; ")}`,
      errors,
    );
  }
}

// ─── Compiler Orchestrator ───────────────────────────────────────────────────

import { parse } from "./parser.ts";
import { resolve } from "./resolver.ts";
import { typecheck } from "./typechecker.ts";
import { checkConflicts, type ConflictCheckResult } from "./conflicts.ts";
import type { CompileWarning } from "@shared/types.ts";

type ExistingPolicy = {
  id: string;
  ast: ResolvedPolicyAST;
};

export function compile(
  dsl: string,
  existingPolicies: ExistingPolicy[] = [],
): { result: CompileResult; warnings: CompileWarning[] } {
  // Phase 1: Parse
  const ast = parse(dsl);

  // Phase 2: Resolve
  const resolved = resolve(ast);

  // Phase 3: Type-check
  typecheck(resolved);

  // Phase 4: Conflict detection
  let conflictResult: ConflictCheckResult = { errors: [], warnings: [] };
  conflictResult = checkConflicts(resolved, existingPolicies);

  // Phase 5: Emit Cedar + sidecar
  const { cedar, sidecar } = emit(resolved);

  // Phase 6: Validate Cedar against schema
  validateCedar(cedar);

  const warnings: CompileWarning[] = conflictResult.warnings.map((w) => ({
    code: w.code,
    message: w.message,
  }));

  return {
    result: { cedar, sidecar, ast: resolved },
    warnings,
  };
}
