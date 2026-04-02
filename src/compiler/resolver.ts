import type {
  PolicyAST,
  ResolvedPolicyAST,
  ResolvedResource,
  ResolvedCondition,
  CedarAction,
  AttributeType,
} from "@shared/types.ts";
import {
  GMAIL_MESSAGE_ATTRIBUTES,
  DSL_TO_CEDAR_ACTION,
  ALL_CEDAR_ACTIONS,
  KNOWN_OPERATIONS,
} from "@shared/types.ts";
import { ResolveError } from "./errors.ts";

const VALID_SERVICES = new Set(["gmail"]);
const VALID_RESOURCE_TYPES: Record<string, Set<string>> = {
  gmail: new Set(["messages", "threads"]),
};

export function resolve(ast: PolicyAST): ResolvedPolicyAST {
  const resource = resolveResource(ast.resource);
  const operations = resolveOperations(ast.operations, resource);
  const conditions = ast.conditions?.map(resolveCondition);
  const requiresApproval = ast.requiresApproval
    ? { operations: resolveOperations(ast.requiresApproval.operations, resource) }
    : undefined;

  return {
    kind: ast.kind,
    agent: ast.agent,
    operations,
    resource,
    ...(conditions && { conditions }),
    ...(ast.timeBound && { timeBound: ast.timeBound }),
    ...(requiresApproval && { requiresApproval }),
  };
}

function resolveResource(resource: { service: string; type: string }): ResolvedResource {
  if (!VALID_SERVICES.has(resource.service)) {
    throw new ResolveError(
      `Unknown service '${resource.service}'. Valid services: ${[...VALID_SERVICES].join(", ")}`,
      "resource.service",
    );
  }

  const validTypes = VALID_RESOURCE_TYPES[resource.service]!;
  if (!validTypes.has(resource.type)) {
    throw new ResolveError(
      `Unknown resource type '${resource.type}' for service '${resource.service}'. Valid types: ${[...validTypes].join(", ")}`,
      "resource.type",
    );
  }

  return {
    service: resource.service as "gmail",
    type: resource.type as "messages" | "threads",
  };
}

function resolveOperations(operations: string[] | ["*"], resource: ResolvedResource): CedarAction[] {
  if (operations[0] === "*") {
    return [...ALL_CEDAR_ACTIONS];
  }

  return operations.map((op) => {
    if (!KNOWN_OPERATIONS.includes(op)) {
      throw new ResolveError(
        `Unknown operation '${op}'. Valid operations: ${KNOWN_OPERATIONS.join(", ")}`,
        "operations",
      );
    }
    const action = DSL_TO_CEDAR_ACTION[op];
    if (!action) {
      throw new ResolveError(`Cannot map operation '${op}' to a Cedar action`, "operations");
    }
    return action;
  });
}

function resolveCondition(condition: { attribute: string; operator: string; value: string | string[] | number | boolean }): ResolvedCondition {
  const attributeType = getAttributeType(condition.attribute);
  return {
    ...condition,
    attributeType,
  } as ResolvedCondition;
}

function getAttributeType(attribute: string): AttributeType {
  const type = GMAIL_MESSAGE_ATTRIBUTES[attribute];
  if (!type) {
    const known = Object.keys(GMAIL_MESSAGE_ATTRIBUTES).join(", ");
    throw new ResolveError(
      `Unknown attribute '${attribute}'. Valid attributes: ${known}`,
      attribute,
    );
  }
  return type;
}
