// ─── DSL AST Types ───────────────────────────────────────────────────────────

export type PolicyKind = "allow" | "deny" | "noaction";

export type Schedule = {
  days: "weekdays" | "weekends" | "everyday";
  startHour: number; // 0-23
  endHour: number;   // 0-23
};

export type TimeBound =
  | { kind: "duration"; seconds: number }
  | { kind: "until"; timestamp: string }
  | { kind: "schedule"; schedule: Schedule }
  | { kind: "session" };

export type ConditionOperator =
  // String operators
  | "==" | "!=" | "like" | "startsWith" | "endsWith"
  // Set operators
  | "contains" | "containsAny" | "containsAll" | "isEmpty"
  // Numeric operators
  | ">" | "<" | ">=" | "<=";

export type Condition = {
  attribute: string;
  operator: ConditionOperator;
  value: string | string[] | number | boolean;
};

export type PolicyAST = {
  kind: PolicyKind;
  agent: string | "*";
  operations: string[] | ["*"];
  resource: { service: string; type: string };
  conditions?: Condition[];
  timeBound?: TimeBound;
  requiresApproval?: { operations: string[] };
};

// ─── Resolved AST (after resolver phase) ─────────────────────────────────────

export type ResolvedResource = {
  service: "gmail";
  type: "messages" | "threads";
};

export type ResolvedCondition = Condition & {
  attributeType: AttributeType;
};

export type ResolvedPolicyAST = {
  kind: PolicyKind;
  agent: string | "*";
  operations: CedarAction[];
  resource: ResolvedResource;
  conditions?: ResolvedCondition[];
  timeBound?: TimeBound;
  requiresApproval?: { operations: CedarAction[] };
};

// ─── Cedar Types ─────────────────────────────────────────────────────────────

export type CedarAction =
  | "gmail:messages:read"
  | "gmail:messages:list"
  | "gmail:messages:draft"
  | "gmail:messages:send"
  | "gmail:messages:archive"
  | "gmail:messages:trash";

export const ALL_CEDAR_ACTIONS: CedarAction[] = [
  "gmail:messages:read",
  "gmail:messages:list",
  "gmail:messages:draft",
  "gmail:messages:send",
  "gmail:messages:archive",
  "gmail:messages:trash",
];

export const DSL_TO_CEDAR_ACTION: Record<string, CedarAction> = {
  read: "gmail:messages:read",
  list: "gmail:messages:list",
  draft: "gmail:messages:draft",
  send: "gmail:messages:send",
  archive: "gmail:messages:archive",
  trash: "gmail:messages:trash",
};

export const KNOWN_OPERATIONS = Object.keys(DSL_TO_CEDAR_ACTION);

// ─── Attribute Schema ────────────────────────────────────────────────────────

export type AttributeType = "String" | "Set<String>" | "Long" | "Bool";

export const GMAIL_MESSAGE_ATTRIBUTES: Record<string, AttributeType> = {
  from: "String",
  to: "Set<String>",
  subject: "String",
  labels: "Set<String>",
  date: "Long",
  threadId: "String",
};

export const VALID_OPERATORS: Record<AttributeType, ConditionOperator[]> = {
  String: ["==", "!=", "like", "startsWith", "endsWith"],
  "Set<String>": ["contains", "containsAny", "containsAll", "isEmpty"],
  Long: ["==", "!=", ">", "<", ">=", "<="],
  Bool: ["==", "!="],
};

// ─── Compiler Output ─────────────────────────────────────────────────────────

export type ApplicationSidecar = {
  requiresApproval?: CedarAction[];
  sessionScoped?: boolean;
};

export type CompileResult = {
  cedar: string;
  sidecar: ApplicationSidecar;
  ast: ResolvedPolicyAST;
};

export type CompileWarning = {
  code: string;
  message: string;
};

export type CompileOutput = {
  result: CompileResult;
  warnings: CompileWarning[];
};

// ─── Policy Engine ───────────────────────────────────────────────────────────

export type PolicyDecision =
  | { effect: "permit" }
  | { effect: "deny"; reason: string }
  | { effect: "pending_approval"; approvalId: string };

export type PolicyRequest = {
  agentId: string;
  agentName: string;
  action: CedarAction;
  resource: GmailMessageAttributes;
};

export type PolicyContext = {
  now: number;         // Unix timestamp
  grantedAt: number;   // Policy creation timestamp
  hourOfDay: number;   // 0-23, user's timezone
  dayOfWeek: number;   // 1=Mon, 7=Sun
};

// ─── Risk Tiers ──────────────────────────────────────────────────────────────

export type RiskTier = "low" | "medium" | "high" | "critical";

export const ACTION_RISK_TIERS: Record<CedarAction, RiskTier> = {
  "gmail:messages:read": "low",
  "gmail:messages:list": "low",
  "gmail:messages:draft": "medium",
  "gmail:messages:archive": "medium",
  "gmail:messages:send": "high",
  "gmail:messages:trash": "critical",
};

// ─── Gmail Types ─────────────────────────────────────────────────────────────

export type GmailMessageAttributes = {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  labels: string[];
  date: number; // Unix timestamp
};

export type GmailMessage = GmailMessageAttributes & {
  snippet: string;
  hasAttachments: boolean;
};

// ─── Approval Types ──────────────────────────────────────────────────────────

export type ApprovalRequest = {
  id: string;
  agentId: string;
  agentName: string;
  action: CedarAction;
  resource: {
    type: string;
    id: string;
    from?: string;
    subject?: string;
  };
  riskTier: RiskTier;
  draftId?: string;
  expiresAt: Date;
};

export type ApprovalResponse =
  | { type: "allow_once" }
  | { type: "allow_session" }
  | { type: "allow_duration"; duration: string }
  | { type: "deny" };

// ─── Classification Types ────────────────────────────────────────────────────

export const CLASSIFICATION_LABELS = [
  "sma/class/auth",
  "sma/class/alert",
  "sma/class/notification",
  "sma/class/comment",
  "sma/class/subscription",
  "sma/class/marketing",
  "sma/class/receipt",
  "sma/class/calendar",
  "sma/class/personal",
  "sma/class/work",
  "sma/class/finance",
  "sma/class/shipping",
  "sma/class/unknown",
] as const;

export type ClassificationLabel = (typeof CLASSIFICATION_LABELS)[number];

export type ClassificationResult = {
  labels: ClassificationLabel[];
  method: "deterministic" | "llm";
  confidence?: number;
};

export type EmailMetadata = {
  from: string;
  to?: string[];
  subject: string;
  snippet?: string;
  headers?: Record<string, string>;
};

// ─── NL Translation Types ────────────────────────────────────────────────────

export type TranslationResult = {
  dsl: string;
  confidence: number;
  ambiguities: string[];
};

export type ClarificationRequest = {
  question: string;
  field: string;
  suggestions?: string[];
};

// ─── Audit Types ─────────────────────────────────────────────────────────────

export type AuditDecision = "permit" | "deny" | "pending_approval";

export type AuditEntry = {
  id: string;
  agentId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  decision: AuditDecision;
  matchedPolicies: string[];
  workflowRunId?: string;
  outcome: "executed" | "blocked" | "pending_approval";
  createdAt: Date;
};

// ─── Session & Grant Types ───────────────────────────────────────────────────

export type GrantType = "once" | "session";

export type SessionGrant = {
  id: string;
  agentId: string;
  sessionId: string;
  action: CedarAction;
  grantType: GrantType;
  consumed: boolean;
  createdAt: Date;
};
