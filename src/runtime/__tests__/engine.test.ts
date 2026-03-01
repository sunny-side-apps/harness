import { describe, it, expect, beforeEach } from "bun:test";
import { PolicyEngine } from "../policy-engine.ts";
import { RequestEngine, type StoredPolicy, type EngineSessionGrant, type EvaluationContext } from "../engine.ts";
import type { GmailMessageAttributes, CedarAction } from "@shared/types.ts";

describe("RequestEngine", () => {
  let policyEngine: PolicyEngine;
  let requestEngine: RequestEngine;

  const defaultResource: GmailMessageAttributes = {
    id: "msg-123",
    threadId: "thread-1",
    from: "alice@team.com",
    to: ["bob@example.com"],
    subject: "Project update",
    labels: ["sma/class/work"],
    date: 1740571200,
  };

  const defaultRequestContext = {
    agentId: "agent-1",
    agentName: "openclaw",
    sessionId: "session-1",
    userTimezone: "UTC",
  };

  function makePolicy(overrides: Partial<StoredPolicy> & { id: string; cedar: string }): StoredPolicy {
    return {
      agentId: "agent-1",
      sidecar: {},
      enabled: true,
      expiresAt: null,
      createdAt: new Date("2026-02-01T10:00:00Z"),
      ...overrides,
    };
  }

  function makeEvalContext(
    policies: StoredPolicy[],
    sessionGrants: EngineSessionGrant[] = [],
  ): EvaluationContext {
    return { policies, sessionGrants };
  }

  beforeEach(() => {
    policyEngine = new PolicyEngine();
    policyEngine.initialize();
    requestEngine = new RequestEngine(policyEngine);
  });

  // ─── Basic permit/deny ──────────────────────────────────────────────────

  it("permits when Cedar allows", () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:read",
      defaultResource,
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("permit");
  });

  it("denies when no matching policy - default deny", () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@specific.com"
        };`,
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:read",
      { ...defaultResource, from: "alice@other.com" },
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("deny");
  });

  it("denies when no policies at all", () => {
    const result = requestEngine.evaluate(
      "gmail:messages:read",
      defaultResource,
      defaultRequestContext,
      makeEvalContext([]),
    );

    expect(result.effect).toBe("deny");
    if (result.effect === "deny") {
      expect(result.reason).toBe("no matching policy");
    }
  });

  // ─── No-action zones ──────────────────────────────────────────────────

  it("denies immediately for no-action zone", () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `forbid(
  principal,
  action in [
    AgentGate::Action::"gmail:messages:read",
    AgentGate::Action::"gmail:messages:list",
    AgentGate::Action::"gmail:messages:draft",
    AgentGate::Action::"gmail:messages:send",
    AgentGate::Action::"gmail:messages:archive",
    AgentGate::Action::"gmail:messages:trash"
  ],
  resource is AgentGate::GmailMessage
);`,
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:read",
      defaultResource,
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("deny");
    if (result.effect === "deny") {
      expect(result.reason).toBe("no-action zone active");
    }
  });

  // ─── Session grants ─────────────────────────────────────────────────────

  it("permits via session grant", () => {
    const grants: EngineSessionGrant[] = [
      {
        id: "grant-1",
        action: "gmail:messages:archive",
        grantType: "session",
        consumed: false,
      },
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:archive",
      defaultResource,
      defaultRequestContext,
      makeEvalContext([], grants),
    );

    expect(result.effect).toBe("permit");
  });

  it("permits via one-time grant and flags for consumption", () => {
    const grants: EngineSessionGrant[] = [
      {
        id: "grant-1",
        action: "gmail:messages:trash",
        grantType: "once",
        consumed: false,
      },
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:trash",
      defaultResource,
      defaultRequestContext,
      makeEvalContext([], grants),
    );

    expect(result.effect).toBe("permit");
    if (result.effect === "permit") {
      expect(result.consumeGrantId).toBe("grant-1");
    }
  });

  it("does not permit consumed one-time grant", () => {
    const grants: EngineSessionGrant[] = [
      {
        id: "grant-1",
        action: "gmail:messages:trash",
        grantType: "once",
        consumed: true,
      },
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:trash",
      defaultResource,
      defaultRequestContext,
      makeEvalContext([], grants),
    );

    expect(result.effect).toBe("deny");
  });

  it("does not use grants when no session", () => {
    const grants: EngineSessionGrant[] = [
      {
        id: "grant-1",
        action: "gmail:messages:archive",
        grantType: "session",
        consumed: false,
      },
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:archive",
      defaultResource,
      { ...defaultRequestContext, sessionId: null },
      makeEvalContext([], grants),
    );

    // No session → grants not checked → deny (no Cedar policies)
    expect(result.effect).toBe("deny");
  });

  // ─── Approval requirements ────────────────────────────────────────────

  it("returns pending_approval when sidecar requires approval for action", () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action in [
            AgentGate::Action::"gmail:messages:read",
            AgentGate::Action::"gmail:messages:archive"
          ],
          resource is AgentGate::GmailMessage
        );`,
        sidecar: { requiresApproval: ["gmail:messages:archive"] },
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:archive",
      defaultResource,
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("pending_approval");
  });

  it("permits when action is not in requiresApproval", () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action in [
            AgentGate::Action::"gmail:messages:read",
            AgentGate::Action::"gmail:messages:archive"
          ],
          resource is AgentGate::GmailMessage
        );`,
        sidecar: { requiresApproval: ["gmail:messages:archive"] },
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:read",
      defaultResource,
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("permit");
  });

  // ─── Policy filtering ────────────────────────────────────────────────

  it("filters expired policies", () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
        expiresAt: new Date("2020-01-01T00:00:00Z"), // expired
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:read",
      defaultResource,
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("deny");
  });

  it("filters disabled policies", () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
        enabled: false,
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:read",
      defaultResource,
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("deny");
  });

  // ─── Wildcard agent policies ──────────────────────────────────────────

  it("respects wildcard agent policies (agentId = null)", () => {
    const policies = [
      makePolicy({
        id: "p1",
        agentId: null,
        cedar: `permit(
          principal,
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:read",
      defaultResource,
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("permit");
  });

  // ─── Matched policy IDs ──────────────────────────────────────────────

  it("includes matched policy IDs in permit decision", () => {
    const policies = [
      makePolicy({
        id: "p-uuid-123",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      }),
    ];

    const result = requestEngine.evaluate(
      "gmail:messages:read",
      defaultResource,
      defaultRequestContext,
      makeEvalContext(policies),
    );

    expect(result.effect).toBe("permit");
    if (result.effect === "permit") {
      expect(result.matchedPolicies).toContain("p-uuid-123");
    }
  });
});
