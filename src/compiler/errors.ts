import { CompilerError } from "@shared/errors.ts";

export class ParseError extends CompilerError {
  constructor(message: string, public readonly position?: number) {
    super(message, "parse", position !== undefined ? `at position ${position}` : undefined);
    this.name = "ParseError";
  }
}

export class ResolveError extends CompilerError {
  constructor(message: string, public readonly field?: string) {
    super(message, "resolve", field ? `field: ${field}` : undefined);
    this.name = "ResolveError";
  }
}

export class TypecheckError extends CompilerError {
  constructor(
    message: string,
    public readonly attribute?: string,
    public readonly operator?: string,
  ) {
    super(message, "typecheck", attribute ? `attribute: ${attribute}, operator: ${operator}` : undefined);
    this.name = "TypecheckError";
  }
}

export type ConflictSeverity = "error" | "warning";

export type ConflictIssue = {
  severity: ConflictSeverity;
  code: string;
  message: string;
  existingPolicyId?: string;
};

export class ConflictError extends CompilerError {
  constructor(
    message: string,
    public readonly issues: ConflictIssue[],
  ) {
    super(message, "conflict", issues.map((i) => `[${i.severity}] ${i.message}`).join("; "));
    this.name = "ConflictError";
  }
}

export class EmitError extends CompilerError {
  constructor(message: string) {
    super(message, "emit");
    this.name = "EmitError";
  }
}

export class ValidationError extends CompilerError {
  constructor(
    message: string,
    public readonly cedarErrors?: string[],
  ) {
    super(message, "validate", cedarErrors?.join("; "));
    this.name = "ValidationError";
  }
}
