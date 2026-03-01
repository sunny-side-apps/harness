import type { ResolvedPolicyAST, ResolvedCondition, AttributeType, ConditionOperator } from "@shared/types.ts";
import { VALID_OPERATORS } from "@shared/types.ts";
import { TypecheckError } from "./errors.ts";

export function typecheck(ast: ResolvedPolicyAST): void {
  if (!ast.conditions) return;

  for (const condition of ast.conditions) {
    checkCondition(condition);
  }
}

function checkCondition(condition: ResolvedCondition): void {
  const { attribute, operator, attributeType, value } = condition;
  const validOps = VALID_OPERATORS[attributeType];

  if (!validOps) {
    throw new TypecheckError(
      `Unknown attribute type '${attributeType}' for attribute '${attribute}'`,
      attribute,
      operator,
    );
  }

  if (!validOps.includes(operator)) {
    const suggestion = suggestOperator(attributeType, operator);
    throw new TypecheckError(
      `Operator '${operator}' is not valid for attribute '${attribute}' (type ${attributeType}). ` +
      `Valid operators: ${validOps.join(", ")}` +
      (suggestion ? `. Did you mean '${suggestion}'?` : ""),
      attribute,
      operator,
    );
  }

  checkValueType(condition);
}

function checkValueType(condition: ResolvedCondition): void {
  const { attribute, operator, attributeType, value } = condition;

  if (operator === "isEmpty") return; // No value needed

  switch (attributeType) {
    case "String":
      if (typeof value !== "string") {
        throw new TypecheckError(
          `Attribute '${attribute}' (type String) requires a string value, got ${typeof value}`,
          attribute,
          operator,
        );
      }
      break;

    case "Set<String>":
      if (operator === "contains" && typeof value !== "string") {
        throw new TypecheckError(
          `'contains' on '${attribute}' requires a string value, got ${typeof value}`,
          attribute,
          operator,
        );
      }
      if ((operator === "containsAny" || operator === "containsAll") && !Array.isArray(value)) {
        throw new TypecheckError(
          `'${operator}' on '${attribute}' requires an array of strings, got ${typeof value}`,
          attribute,
          operator,
        );
      }
      break;

    case "Long":
      if (typeof value !== "number") {
        throw new TypecheckError(
          `Attribute '${attribute}' (type Long) requires a numeric value, got ${typeof value}`,
          attribute,
          operator,
        );
      }
      break;

    case "Bool":
      if (typeof value !== "boolean") {
        throw new TypecheckError(
          `Attribute '${attribute}' (type Bool) requires a boolean value, got ${typeof value}`,
          attribute,
          operator,
        );
      }
      break;
  }
}

function suggestOperator(type: AttributeType, attempted: ConditionOperator): string | null {
  const suggestions: Record<string, Record<string, string>> = {
    String: { contains: "like", ">": "like", "<": "like" },
    "Set<String>": { "==": "contains", like: "contains" },
    Long: { like: "==", contains: "==" },
  };
  return suggestions[type]?.[attempted] ?? null;
}
