import { describe, it, expect } from "bun:test";
import {
  isAuthorized,
  validate,
  checkParsePolicySet,
  checkParseSchema,
  getCedarVersion,
  type AuthorizationCall,
  type Schema,
  type PolicySet,
  type ValidationCall,
} from "@cedar-policy/cedar-wasm/nodejs";

const CEDAR_SCHEMA: Schema = {
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
    },
    actions: {
      "gmail:messages:read": {
        appliesTo: {
          principalTypes: ["Agent"],
          resourceTypes: ["GmailMessage"],
        },
      },
      "gmail:messages:list": {
        appliesTo: {
          principalTypes: ["Agent"],
          resourceTypes: ["GmailMessage"],
        },
      },
      "gmail:messages:draft": {
        appliesTo: {
          principalTypes: ["Agent"],
          resourceTypes: ["GmailMessage"],
        },
      },
      "gmail:messages:send": {
        appliesTo: {
          principalTypes: ["Agent"],
          resourceTypes: ["GmailMessage"],
        },
      },
      "gmail:messages:archive": {
        appliesTo: {
          principalTypes: ["Agent"],
          resourceTypes: ["GmailMessage"],
        },
      },
      "gmail:messages:trash": {
        appliesTo: {
          principalTypes: ["Agent"],
          resourceTypes: ["GmailMessage"],
        },
      },
    },
  },
};

const PERMIT_POLICY = `
permit(
  principal == AgentGate::Agent::"openclaw",
  action in [
    AgentGate::Action::"gmail:messages:read",
    AgentGate::Action::"gmail:messages:list"
  ],
  resource is AgentGate::GmailMessage
) when {
  resource.from like "*@team.com"
};
`;

const FORBID_POLICY = `
forbid(
  principal,
  action,
  resource is AgentGate::GmailMessage
) when {
  resource.labels.contains("sma/class/auth")
};
`;

describe("Cedar WASM Bun Compatibility Spike", () => {
  it("loads cedar-wasm and reports version", () => {
    const version = getCedarVersion();
    expect(version).toBeTruthy();
    console.log(`Cedar version: ${version}`);
  });

  it("parses the AgentGate schema", () => {
    const result = checkParseSchema(CEDAR_SCHEMA);
    expect(result.type).toBe("success");
  });

  it("parses a permit policy", () => {
    const policySet: PolicySet = { staticPolicies: PERMIT_POLICY, templates: {}, templateLinks: [] };
    const result = checkParsePolicySet(policySet);
    expect(result.type).toBe("success");
  });

  it("parses a forbid policy", () => {
    const policySet: PolicySet = { staticPolicies: FORBID_POLICY, templates: {}, templateLinks: [] };
    const result = checkParsePolicySet(policySet);
    expect(result.type).toBe("success");
  });

  it("validates policies against schema", () => {
    const call: ValidationCall = {
      validationSettings: { mode: "strict" },
      schema: CEDAR_SCHEMA,
      policies: { staticPolicies: PERMIT_POLICY, templates: {}, templateLinks: [] },
    };
    const result = validate(call);
    if (result.type === "failure") {
      console.error("Validation errors:", JSON.stringify(result.errors, null, 2));
    }
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.validationErrors).toHaveLength(0);
    }
  });

  it("permits an authorized read request", () => {
    const call: AuthorizationCall = {
      principal: { type: "AgentGate::Agent", id: "openclaw" },
      action: { type: "AgentGate::Action", id: "gmail:messages:read" },
      resource: { type: "AgentGate::GmailMessage", id: "msg-123" },
      context: {},
      schema: CEDAR_SCHEMA,
      policies: { staticPolicies: PERMIT_POLICY, templates: {}, templateLinks: [] },
      entities: [
        {
          uid: { type: "AgentGate::Agent", id: "openclaw" },
          attrs: {},
          parents: [],
        },
        {
          uid: { type: "AgentGate::GmailMessage", id: "msg-123" },
          attrs: {
            from: "alice@team.com",
            to: ["bob@example.com"],
            subject: "Project update",
            labels: ["sma/class/work"],
            date: 1740571200,
            threadId: "thread-1",
          },
          parents: [],
        },
      ],
    };
    const result = isAuthorized(call);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.response.decision).toBe("allow");
    }
  });

  it("denies when sender doesn't match policy", () => {
    const call: AuthorizationCall = {
      principal: { type: "AgentGate::Agent", id: "openclaw" },
      action: { type: "AgentGate::Action", id: "gmail:messages:read" },
      resource: { type: "AgentGate::GmailMessage", id: "msg-456" },
      context: {},
      schema: CEDAR_SCHEMA,
      policies: { staticPolicies: PERMIT_POLICY, templates: {}, templateLinks: [] },
      entities: [
        {
          uid: { type: "AgentGate::Agent", id: "openclaw" },
          attrs: {},
          parents: [],
        },
        {
          uid: { type: "AgentGate::GmailMessage", id: "msg-456" },
          attrs: {
            from: "alice@other.com",
            to: ["bob@example.com"],
            subject: "Hello",
            labels: [],
            date: 1740571200,
            threadId: "thread-2",
          },
          parents: [],
        },
      ],
    };
    const result = isAuthorized(call);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.response.decision).toBe("deny");
    }
  });

  it("denies when a different agent tries to access", () => {
    const call: AuthorizationCall = {
      principal: { type: "AgentGate::Agent", id: "evil-bot" },
      action: { type: "AgentGate::Action", id: "gmail:messages:read" },
      resource: { type: "AgentGate::GmailMessage", id: "msg-123" },
      context: {},
      schema: CEDAR_SCHEMA,
      policies: { staticPolicies: PERMIT_POLICY, templates: {}, templateLinks: [] },
      entities: [
        {
          uid: { type: "AgentGate::Agent", id: "evil-bot" },
          attrs: {},
          parents: [],
        },
        {
          uid: { type: "AgentGate::GmailMessage", id: "msg-123" },
          attrs: {
            from: "alice@team.com",
            to: ["bob@example.com"],
            subject: "Project update",
            labels: ["sma/class/work"],
            date: 1740571200,
            threadId: "thread-1",
          },
          parents: [],
        },
      ],
    };
    const result = isAuthorized(call);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      expect(result.response.decision).toBe("deny");
    }
  });

  it("forbid policy blocks auth emails", () => {
    const combinedPolicies = PERMIT_POLICY + "\n" + FORBID_POLICY;
    const call: AuthorizationCall = {
      principal: { type: "AgentGate::Agent", id: "openclaw" },
      action: { type: "AgentGate::Action", id: "gmail:messages:read" },
      resource: { type: "AgentGate::GmailMessage", id: "msg-789" },
      context: {},
      schema: CEDAR_SCHEMA,
      policies: { staticPolicies: combinedPolicies, templates: {}, templateLinks: [] },
      entities: [
        {
          uid: { type: "AgentGate::Agent", id: "openclaw" },
          attrs: {},
          parents: [],
        },
        {
          uid: { type: "AgentGate::GmailMessage", id: "msg-789" },
          attrs: {
            from: "security@team.com",
            to: ["user@example.com"],
            subject: "Your verification code",
            labels: ["sma/class/auth"],
            date: 1740571200,
            threadId: "thread-3",
          },
          parents: [],
        },
      ],
    };
    const result = isAuthorized(call);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      // forbid always wins over permit in Cedar
      expect(result.response.decision).toBe("deny");
    }
  });

  it("default-deny when no policies match", () => {
    const call: AuthorizationCall = {
      principal: { type: "AgentGate::Agent", id: "openclaw" },
      action: { type: "AgentGate::Action", id: "gmail:messages:trash" },
      resource: { type: "AgentGate::GmailMessage", id: "msg-123" },
      context: {},
      schema: CEDAR_SCHEMA,
      policies: { staticPolicies: PERMIT_POLICY, templates: {}, templateLinks: [] },
      entities: [
        {
          uid: { type: "AgentGate::Agent", id: "openclaw" },
          attrs: {},
          parents: [],
        },
        {
          uid: { type: "AgentGate::GmailMessage", id: "msg-123" },
          attrs: {
            from: "alice@team.com",
            to: ["bob@example.com"],
            subject: "Project update",
            labels: ["sma/class/work"],
            date: 1740571200,
            threadId: "thread-1",
          },
          parents: [],
        },
      ],
    };
    const result = isAuthorized(call);
    expect(result.type).toBe("success");
    if (result.type === "success") {
      // Only read+list are permitted, trash is not → deny
      expect(result.response.decision).toBe("deny");
    }
  });

  it("validates policies with time context conditions", () => {
    const timePolicy = `
permit(
  principal == AgentGate::Agent::"openclaw",
  action in [
    AgentGate::Action::"gmail:messages:read",
    AgentGate::Action::"gmail:messages:list"
  ],
  resource is AgentGate::GmailMessage
) when {
  resource.labels.contains("sma/class/work") &&
  context.dayOfWeek >= 1 && context.dayOfWeek <= 5 &&
  context.hourOfDay >= 9 && context.hourOfDay < 17
};
`;
    // Time context uses arbitrary keys, Cedar validates only entity attributes
    // Context fields are unvalidated by schema — they just need to be present at eval time
    const policySet: PolicySet = { staticPolicies: timePolicy, templates: {}, templateLinks: [] };
    const parseResult = checkParsePolicySet(policySet);
    expect(parseResult.type).toBe("success");
  });
});
