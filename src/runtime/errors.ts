import { AppError } from "@shared/errors.ts";

export class PolicyLoadError extends AppError {
  constructor(
    message: string,
    public readonly agentId?: string,
  ) {
    super(message, "POLICY_LOAD_ERROR", 500);
    this.name = "PolicyLoadError";
  }
}

export class PolicyEvaluationError extends AppError {
  constructor(
    message: string,
    public readonly agentId?: string,
    public readonly action?: string,
  ) {
    super(message, "POLICY_EVALUATION_ERROR", 500);
    this.name = "PolicyEvaluationError";
  }
}

export class ContextBuildError extends AppError {
  constructor(
    message: string,
    public readonly timezone?: string,
  ) {
    super(message, "CONTEXT_BUILD_ERROR", 500);
    this.name = "ContextBuildError";
  }
}

export class FilterError extends AppError {
  constructor(
    message: string,
    public readonly agentId?: string,
  ) {
    super(message, "FILTER_ERROR", 500);
    this.name = "FilterError";
  }
}
