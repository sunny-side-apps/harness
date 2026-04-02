import { describe, it, expect, beforeEach } from "bun:test";
import { PolicyEngine } from "../policy-engine.ts";
import { RequestEngine, type StoredPolicy, type EvaluationContext } from "../engine.ts";
import { PostFetchFilter, extractAttributes, type FilterContext } from "../filter.ts";
import type { GmailMessage } from "@shared/types.ts";

describe("PostFetchFilter", () => {
  let policyEngine: PolicyEngine;
  let requestEngine: RequestEngine;
  let filter: PostFetchFilter;

  function makeMessage(overrides: Partial<GmailMessage> & { id: string }): GmailMessage {
    return {
      threadId: "thread-1",
      from: "alice@team.com",
      to: ["bob@example.com"],
      subject: "Test",
      labels: ["sma/class/work"],
      date: 1740571200,
      snippet: "Test message",
      hasAttachments: false,
      ...overrides,
    };
  }

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

  const defaultFilterContext: FilterContext = {
    agentId: "agent-1",
    agentName: "openclaw",
    sessionId: "session-1",
    userTimezone: "UTC",
    requestedLimit: 10,
    currentRound: 0,
  };

  beforeEach(() => {
    policyEngine = new PolicyEngine();
    policyEngine.initialize();
    requestEngine = new RequestEngine(policyEngine);
    filter = new PostFetchFilter(requestEngine);
  });

  // ─── extractAttributes ────────────────────────────────────────────────

  it("extracts attributes correctly from GmailMessage", () => {
    const msg = makeMessage({
      id: "msg-1",
      threadId: "t-1",
      from: "test@team.com",
      to: ["a@b.com", "c@d.com"],
      subject: "Hello",
      labels: ["sma/class/work", "INBOX"],
      date: 1234567890,
    });

    const attrs = extractAttributes(msg);

    expect(attrs.id).toBe("msg-1");
    expect(attrs.threadId).toBe("t-1");
    expect(attrs.from).toBe("test@team.com");
    expect(attrs.to).toEqual(["a@b.com", "c@d.com"]);
    expect(attrs.subject).toBe("Hello");
    expect(attrs.labels).toEqual(["sma/class/work", "INBOX"]);
    expect(attrs.date).toBe(1234567890);
    // Should not include snippet or hasAttachments
    expect((attrs as any).snippet).toBeUndefined();
    expect((attrs as any).hasAttachments).toBeUndefined();
  });

  // ─── Filtering ────────────────────────────────────────────────────────

  it("allows messages matching policy", async () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@team.com"
        };`,
      }),
    ];

    const messages = [
      makeMessage({ id: "msg-1", from: "alice@team.com" }),
      makeMessage({ id: "msg-2", from: "bob@team.com" }),
    ];

    const evalCtx: EvaluationContext = { policies, sessionGrants: [] };
    const result = await filter.filter(messages, "gmail:messages:read", defaultFilterContext, evalCtx);

    expect(result.allowed).toHaveLength(2);
    expect(result.filteredCount).toBe(0);
  });

  it("filters messages not matching policy", async () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@team.com"
        };`,
      }),
    ];

    const messages = [
      makeMessage({ id: "msg-1", from: "alice@team.com" }),
      makeMessage({ id: "msg-2", from: "bob@external.com" }),
      makeMessage({ id: "msg-3", from: "carol@team.com" }),
    ];

    const evalCtx: EvaluationContext = { policies, sessionGrants: [] };
    const result = await filter.filter(messages, "gmail:messages:read", defaultFilterContext, evalCtx);

    expect(result.allowed).toHaveLength(2);
    expect(result.allowed[0].id).toBe("msg-1");
    expect(result.allowed[1].id).toBe("msg-3");
    expect(result.filteredCount).toBe(1);
  });

  it("signals over-fetch when filtered count below limit - round 0", async () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@team.com"
        };`,
      }),
    ];

    const messages = [
      makeMessage({ id: "msg-1", from: "alice@team.com" }),
      makeMessage({ id: "msg-2", from: "bob@external.com" }),
    ];

    const ctx: FilterContext = { ...defaultFilterContext, requestedLimit: 5, currentRound: 0 };
    const evalCtx: EvaluationContext = { policies, sessionGrants: [] };
    const result = await filter.filter(messages, "gmail:messages:read", ctx, evalCtx);

    expect(result.allowed).toHaveLength(1);
    expect(result.shouldOverfetch).toBe(true);
  });

  it("does not signal over-fetch on round 3", async () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@team.com"
        };`,
      }),
    ];

    const messages = [
      makeMessage({ id: "msg-1", from: "alice@team.com" }),
    ];

    const ctx: FilterContext = { ...defaultFilterContext, requestedLimit: 5, currentRound: 3 };
    const evalCtx: EvaluationContext = { policies, sessionGrants: [] };
    const result = await filter.filter(messages, "gmail:messages:read", ctx, evalCtx);

    expect(result.allowed).toHaveLength(1);
    expect(result.shouldOverfetch).toBe(false);
  });

  it("handles empty message list", async () => {
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

    const evalCtx: EvaluationContext = { policies, sessionGrants: [] };
    const result = await filter.filter([], "gmail:messages:read", defaultFilterContext, evalCtx);

    expect(result.allowed).toHaveLength(0);
    expect(result.filteredCount).toBe(0);
    expect(result.shouldOverfetch).toBe(true); // 0 < limit(10), round 0
  });

  it("handles all messages filtered", async () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.from like "*@team.com"
        };`,
      }),
    ];

    const messages = [
      makeMessage({ id: "msg-1", from: "alice@external.com" }),
      makeMessage({ id: "msg-2", from: "bob@external.com" }),
    ];

    const evalCtx: EvaluationContext = { policies, sessionGrants: [] };
    const result = await filter.filter(messages, "gmail:messages:read", defaultFilterContext, evalCtx);

    expect(result.allowed).toHaveLength(0);
    expect(result.filteredCount).toBe(2);
    expect(result.shouldOverfetch).toBe(true);
  });

  it("evaluates each message independently", async () => {
    const policies = [
      makePolicy({
        id: "p1",
        cedar: `permit(
          principal == AgentGate::Agent::"openclaw",
          action == AgentGate::Action::"gmail:messages:read",
          resource is AgentGate::GmailMessage
        ) when {
          resource.labels.contains("sma/class/work")
        };`,
      }),
    ];

    const messages = [
      makeMessage({ id: "msg-1", labels: ["sma/class/work"] }),
      makeMessage({ id: "msg-2", labels: ["sma/class/personal"] }),
      makeMessage({ id: "msg-3", labels: ["sma/class/work", "sma/class/alert"] }),
    ];

    const evalCtx: EvaluationContext = { policies, sessionGrants: [] };
    const result = await filter.filter(messages, "gmail:messages:read", defaultFilterContext, evalCtx);

    expect(result.allowed).toHaveLength(2);
    expect(result.allowed.map((m) => m.id)).toEqual(["msg-1", "msg-3"]);
    expect(result.filteredCount).toBe(1);
  });

  it("does not signal over-fetch when limit is met", async () => {
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

    const messages = [
      makeMessage({ id: "msg-1" }),
      makeMessage({ id: "msg-2" }),
      makeMessage({ id: "msg-3" }),
    ];

    const ctx: FilterContext = { ...defaultFilterContext, requestedLimit: 3, currentRound: 0 };
    const evalCtx: EvaluationContext = { policies, sessionGrants: [] };
    const result = await filter.filter(messages, "gmail:messages:read", ctx, evalCtx);

    expect(result.allowed).toHaveLength(3);
    expect(result.shouldOverfetch).toBe(false);
  });
});
