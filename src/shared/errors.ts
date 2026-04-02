export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// Auth errors
export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super(message, "AUTHENTICATION_REQUIRED", 401);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Access denied") {
    super(message, "ACCESS_DENIED", 403);
    this.name = "AuthorizationError";
  }
}

export class AgentNotFoundError extends AppError {
  constructor(message = "Agent not found or revoked") {
    super(message, "AGENT_NOT_FOUND", 401);
    this.name = "AgentNotFoundError";
  }
}

// Policy errors
export class PolicyDeniedError extends AppError {
  constructor(
    message = "Request denied by policy",
    public readonly reason?: string,
  ) {
    super(message, "POLICY_DENIED", 403);
    this.name = "PolicyDeniedError";
  }
}

export class PolicyPendingApprovalError extends AppError {
  constructor(public readonly approvalId: string) {
    super("Action requires approval", "PENDING_APPROVAL", 202);
    this.name = "PolicyPendingApprovalError";
  }
}

// Compiler errors
export class CompilerError extends AppError {
  constructor(
    message: string,
    public readonly phase: "parse" | "resolve" | "typecheck" | "conflict" | "emit" | "validate",
    public readonly details?: string,
  ) {
    super(message, "COMPILER_ERROR", 400);
    this.name = "CompilerError";
  }
}

// External service errors
export class ServiceUnavailableError extends AppError {
  constructor(
    public readonly service: string,
    message?: string,
  ) {
    super(message ?? `${service} is unavailable`, "SERVICE_UNAVAILABLE", 503);
    this.name = "ServiceUnavailableError";
  }
}

export class RateLimitError extends AppError {
  constructor(public readonly retryAfter?: number) {
    super("Rate limit exceeded", "RATE_LIMIT_EXCEEDED", 429);
    this.name = "RateLimitError";
  }
}

export class NotImplementedError extends AppError {
  constructor(feature: string) {
    super(`${feature} is not yet implemented`, "NOT_IMPLEMENTED", 501);
    this.name = "NotImplementedError";
  }
}
