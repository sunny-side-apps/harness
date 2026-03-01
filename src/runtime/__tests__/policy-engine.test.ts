import { describe, it, expect, beforeEach } from "bun:test";
import { PolicyEngine } from "../policy-engine.ts";
import type { GmailMessageAttributes, PolicyContext } from "@shared/types.ts";

describe("PolicyEngine", () => {
  let engine: PolicyEngine;

  const defaultResource: GmailMessageAttributes = {
    id: "msg-123",
    threadId: "thread-1",
    from: "alice@team.com",
    to: ["bob@example.com"],
    subject: "Project update",
    labels: ["sma/class/work"],
    date: 1740571200,
  };

  const defaultContext: PolicyContext = {
    now: 1740571200,
    grantedAt: 1740564000, // ~2 hours before now
    hourOfDay: 10,
    dayOfWeek: 3, // Wednesday
  };

  beforeEach(() => {
    engine = new PolicyEngine();
    engine.initialize();
  });

  // ─── Loading ────────────────────────────────────────────────────────────

  it("loads policies successfully", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);

    expect(engine.hasPolicies("agent-1")).toBe(true);
  });

  it("hasPolicies returns false for unknown agent", () => {
    expect(engine.hasPolicies("unknown-agent")).toBe(false);
  });

  it("clearPolicies removes agent policies", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);

    expect(engine.hasPolicies("agent-1")).toBe(true);
    engine.clearPolicies("agent-1");
    expect(engine.hasPolicies("agent-1")).toBe(false);
  });

  it("removes policies when loading empty array", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);
    engine.loadPolicies("agent-1", []);
    expect(engine.hasPolicies("agent-1")).toBe(false);
  });

  // ─── Evaluation ─────────────────────────────────────────────────────────

  it("evaluates permit when policy matches", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@team.com"
        };`,
      },
    ]);

    const result = engine.evaluate(
      "agent-1",
      "openclaw",
      "gmail:messages:read",
      defaultResource,
      defaultContext,
    );

    expect(result.decision).toBe("allow");
    expect(result.reasons).toContain("policy-1");
    expect(result.errors).toHaveLength(0);
  });

  it("evaluates deny when no policy matches - default deny", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@specific.com"
        };`,
      },
    ]);

    const result = engine.evaluate(
      "agent-1",
      "openclaw",
      "gmail:messages:read",
      { ...defaultResource, from: "alice@other.com" },
      defaultContext,
    );

    expect(result.decision).toBe("deny");
  });

  it("evaluates deny when principal does not match", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);

    const result = engine.evaluate(
      "agent-1",
      "evil-bot",
      "gmail:messages:read",
      defaultResource,
      defaultContext,
    );

    expect(result.decision).toBe("deny");
  });

  it("evaluates deny when conditions do not match", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@team.com"
        };`,
      },
    ]);

    const result = engine.evaluate(
      "agent-1",
      "openclaw",
      "gmail:messages:read",
      { ...defaultResource, from: "alice@other.com" },
      defaultContext,
    );

    expect(result.decision).toBe("deny");
  });

  it("forbid policy wins over permit", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
      {
        id: "policy-2",
        cedar: `forbid(
          principal,
          action,
          resource is AgentGate::GmailMessage
        ) when {
          resource.labels.contains("sma/class/auth")
        };`,
      },
    ]);

    const result = engine.evaluate(
      "agent-1",
      "openclaw",
      "gmail:messages:read",
      { ...defaultResource, labels: ["sma/class/auth"] },
      defaultContext,
    );

    expect(result.decision).toBe("deny");
  });

  it("handles time-based conditions - duration valid", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          context.grantedAt + 7200 > context.now
        };`,
      },
    ]);

    // grantedAt + 7200 = 1740571200, now = 1740571200 → 1740571200 > 1740571200 = false (expired)
    // So use a context where it's still valid
    const ctx: PolicyContext = {
      now: 1740567000, // within 2h of grantedAt
      grantedAt: 1740564000,
      hourOfDay: 10,
      dayOfWeek: 3,
    };

    const result = engine.evaluate(
      "agent-1",
      "openclaw",
      "gmail:messages:read",
      defaultResource,
      ctx,
    );

    expect(result.decision).toBe("allow");
  });

  it("handles time-based conditions - duration expired", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          context.grantedAt + 7200 > context.now
        };`,
      },
    ]);

    const ctx: PolicyContext = {
      now: 1740575000, // more than 2h after grantedAt
      grantedAt: 1740564000,
      hourOfDay: 10,
      dayOfWeek: 3,
    };

    const result = engine.evaluate(
      "agent-1",
      "openclaw",
      "gmail:messages:read",
      defaultResource,
      ctx,
    );

    expect(result.decision).toBe("deny");
  });

  it("handles schedule conditions - weekday within hours", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          context.dayOfWeek >= 1 && context.dayOfWeek <= 5 &&
          context.hourOfDay >= 9 && context.hourOfDay < 17
        };`,
      },
    ]);

    // Wednesday at 10am
    const ctx: PolicyContext = {
      now: 1740571200,
      grantedAt: 1740564000,
      hourOfDay: 10,
      dayOfWeek: 3,
    };

    const result = engine.evaluate(
      "agent-1",
      "openclaw",
      "gmail:messages:read",
      defaultResource,
      ctx,
    );

    expect(result.decision).toBe("allow");
  });

  it("handles schedule conditions - weekend denied", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          context.dayOfWeek >= 1 && context.dayOfWeek <= 5 &&
          context.hourOfDay >= 9 && context.hourOfDay < 17
        };`,
      },
    ]);

    // Saturday at 10am
    const ctx: PolicyContext = {
      now: 1740571200,
      grantedAt: 1740564000,
      hourOfDay: 10,
      dayOfWeek: 6,
    };

    const result = engine.evaluate(
      "agent-1",
      "openclaw",
      "gmail:messages:read",
      defaultResource,
      ctx,
    );

    expect(result.decision).toBe("deny");
  });

  it("denies when no policies loaded for agent", () => {
    const result = engine.evaluate(
      "unknown-agent",
      "openclaw",
      "gmail:messages:read",
      defaultResource,
      defaultContext,
    );

    expect(result.decision).toBe("deny");
    expect(result.errors).toContain("no_policies_loaded");
  });

  it("swapPolicies replaces old set", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);

    // Should permit read
    let result = engine.evaluate("agent-1", "openclaw", "gmail:messages:read", defaultResource, defaultContext);
    expect(result.decision).toBe("allow");

    // Swap to only allow list
    engine.swapPolicies("agent-1", [
      {
        id: "policy-2",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:list",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);

    // Read should now be denied
    result = engine.evaluate("agent-1", "openclaw", "gmail:messages:read", defaultResource, defaultContext);
    expect(result.decision).toBe("deny");

    // List should be permitted
    result = engine.evaluate("agent-1", "openclaw", "gmail:messages:list", defaultResource, defaultContext);
    expect(result.decision).toBe("allow");
  });

  it("wildcard principal permits any agent", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal,
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);

    const result = engine.evaluate(
      "agent-1",
      "any-agent-name",
      "gmail:messages:read",
      defaultResource,
      defaultContext,
    );

    expect(result.decision).toBe("allow");
  });

  it("loads multiple policies and evaluates correctly", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
      {
        id: "policy-2",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:list",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);

    const readResult = engine.evaluate("agent-1", "openclaw", "gmail:messages:read", defaultResource, defaultContext);
    expect(readResult.decision).toBe("allow");

    const listResult = engine.evaluate("agent-1", "openclaw", "gmail:messages:list", defaultResource, defaultContext);
    expect(listResult.decision).toBe("allow");

    const draftResult = engine.evaluate("agent-1", "openclaw", "gmail:messages:draft", defaultResource, defaultContext);
    expect(draftResult.decision).toBe("deny");
  });

  it("returns policy IDs in reasons on permit", () => {
    engine.loadPolicies("agent-1", [
      {
        id: "policy-abc",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        );`,
      },
    ]);

    const result = engine.evaluate("agent-1", "openclaw", "gmail:messages:read", defaultResource, defaultContext);

    expect(result.decision).toBe("allow");
    expect(result.reasons).toContain("policy-abc");
  });
});
