import { describe, it, expect } from "bun:test";
import { parse } from "../parser.ts";
import { resolve } from "../resolver.ts";
import { emit, validateCedar, compile } from "../emitter.ts";
import { typecheck } from "../typechecker.ts";

function emitFromDsl(dsl: string) {
  const ast = parse(dsl);
  const resolved = resolve(ast);
  typecheck(resolved);
  return emit(resolved);
}

describe("emitter", () => {
  describe("basic permit/forbid", () => {
    it("emits permit for allow rule", () => {
      const { cedar } = emitFromDsl('allow "openclaw" to [read] on gmail.messages');
      expect(cedar).toContain("permit(");
      expect(cedar).toContain('principal == AgentGate::Agent::"openclaw"');
      expect(cedar).toContain('AgentGate::Action::"gmail:messages:read"');
      expect(cedar).toContain("resource is AgentGate::GmailMessage");
    });

    it("emits forbid for deny rule", () => {
      const { cedar } = emitFromDsl("deny * to [*] on gmail.messages");
      expect(cedar).toContain("forbid(");
      expect(cedar).toContain("principal,"); // wildcard = no constraint
    });

    it("emits forbid for noaction rule", () => {
      const { cedar } = emitFromDsl("noaction * on gmail.messages for 2h");
      expect(cedar).toContain("forbid(");
    });
  });

  describe("principal emission", () => {
    it("emits specific agent principal", () => {
      const { cedar } = emitFromDsl('allow "openclaw" to [read] on gmail.messages');
      expect(cedar).toContain('principal == AgentGate::Agent::"openclaw"');
    });

    it("emits unconstrained principal for wildcard", () => {
      const { cedar } = emitFromDsl("deny * to [read] on gmail.messages");
      expect(cedar).toMatch(/principal,\n/);
    });
  });

  describe("action emission", () => {
    it("emits single action with ==", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages');
      expect(cedar).toContain('action == AgentGate::Action::"gmail:messages:read"');
    });

    it("emits multiple actions with in [...]", () => {
      const { cedar } = emitFromDsl('allow "a" to [read, list] on gmail.messages');
      expect(cedar).toContain("action in [");
      expect(cedar).toContain('AgentGate::Action::"gmail:messages:read"');
      expect(cedar).toContain('AgentGate::Action::"gmail:messages:list"');
    });
  });

  describe("condition emission", () => {
    it("emits like condition", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages where { from like "*@team.com" }');
      expect(cedar).toContain('resource.from like "*@team.com"');
    });

    it("emits equality condition", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages where { from == "alice@co.com" }');
      expect(cedar).toContain('resource.from == "alice@co.com"');
    });

    it("emits contains condition", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages where { labels contains "sma/class/work" }');
      expect(cedar).toContain('resource.labels.contains("sma/class/work")');
    });

    it("emits numeric comparison", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages where { date > 1740571200 }');
      expect(cedar).toContain("resource.date > 1740571200");
    });

    it("emits multiple conditions joined by &&", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages where { from like "*@team.com", labels contains "sma/class/work" }');
      expect(cedar).toContain("&&");
      expect(cedar).toContain('resource.from like "*@team.com"');
      expect(cedar).toContain('resource.labels.contains("sma/class/work")');
    });
  });

  describe("time bound emission", () => {
    it("emits duration condition", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages for 2h');
      expect(cedar).toContain("context.grantedAt + 7200 > context.now");
    });

    it("emits until condition as unix timestamp", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages until "2026-03-01T00:00:00"');
      expect(cedar).toContain("context.now < ");
    });

    it("emits weekday schedule", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages during weekdays(9, 17)');
      expect(cedar).toContain("context.dayOfWeek >= 1 && context.dayOfWeek <= 5");
      expect(cedar).toContain("context.hourOfDay >= 9 && context.hourOfDay < 17");
    });

    it("emits weekend schedule", () => {
      const { cedar } = emitFromDsl('allow "a" to [read] on gmail.messages during weekends(10, 18)');
      expect(cedar).toContain("context.dayOfWeek == 6 || context.dayOfWeek == 7");
      expect(cedar).toContain("context.hourOfDay >= 10 && context.hourOfDay < 18");
    });

    it("does not emit time condition for session (sidecar)", () => {
      const { cedar, sidecar } = emitFromDsl('allow "a" to [read] on gmail.messages for session');
      expect(cedar).not.toContain("context.");
      expect(sidecar.sessionScoped).toBe(true);
    });
  });

  describe("sidecar extraction", () => {
    it("extracts requiresApproval for specific operations", () => {
      const { sidecar } = emitFromDsl('allow "bot" to [read, list, archive] on gmail.messages requires approval for [archive]');
      expect(sidecar.requiresApproval).toEqual(["gmail:messages:archive"]);
    });

    it("excludes approval operations from Cedar", () => {
      const { cedar } = emitFromDsl('allow "bot" to [read, list, archive] on gmail.messages requires approval for [archive]');
      expect(cedar).toContain('AgentGate::Action::"gmail:messages:read"');
      expect(cedar).toContain('AgentGate::Action::"gmail:messages:list"');
      expect(cedar).not.toContain('AgentGate::Action::"gmail:messages:archive"');
    });

    it("extracts session scope", () => {
      const { sidecar } = emitFromDsl('allow "a" to [read] on gmail.messages for session');
      expect(sidecar.sessionScoped).toBe(true);
    });

    it("returns empty sidecar when no sidecar features used", () => {
      const { sidecar } = emitFromDsl('allow "a" to [read] on gmail.messages for 2h');
      expect(sidecar.requiresApproval).toBeUndefined();
      expect(sidecar.sessionScoped).toBeUndefined();
    });
  });

  describe("Cedar validation", () => {
    it("validates emitted permit policy", () => {
      const { cedar } = emitFromDsl('allow "openclaw" to [read, list] on gmail.messages where { from like "*@team.com" } for 2h');
      expect(() => validateCedar(cedar)).not.toThrow();
    });

    it("validates emitted forbid policy", () => {
      const { cedar } = emitFromDsl('deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }');
      expect(() => validateCedar(cedar)).not.toThrow();
    });

    it("validates emitted schedule policy", () => {
      const { cedar } = emitFromDsl('allow "openclaw" to [read, list] on gmail.messages where { labels contains "sma/class/work" } during weekdays(9, 17)');
      expect(() => validateCedar(cedar)).not.toThrow();
    });

    it("validates noaction policy", () => {
      const { cedar } = emitFromDsl("noaction * on gmail.messages for 2h");
      expect(() => validateCedar(cedar)).not.toThrow();
    });

    it("skips validation for empty cedar (sidecar-only)", () => {
      expect(() => validateCedar("")).not.toThrow();
    });
  });
});

describe("compile (full pipeline)", () => {
  it("compiles allow with conditions and time", () => {
    const { result } = compile('allow "openclaw" to [read, list] on gmail.messages where { from like "*@team.com" } for 2h');
    expect(result.cedar).toContain("permit(");
    expect(result.cedar).toContain('resource.from like "*@team.com"');
    expect(result.cedar).toContain("context.grantedAt + 7200 > context.now");
    expect(result.ast.kind).toBe("allow");
  });

  it("compiles deny with label condition", () => {
    const { result } = compile('deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }');
    expect(result.cedar).toContain("forbid(");
    expect(result.cedar).toContain('resource.labels.contains("sma/class/auth")');
  });

  it("compiles schedule policy", () => {
    const { result } = compile('allow "openclaw" to [read, list] on gmail.messages where { labels contains "sma/class/work" } during weekdays(9, 17)');
    expect(result.cedar).toContain("context.dayOfWeek >= 1");
    expect(result.cedar).toContain("context.hourOfDay >= 9");
  });

  it("compiles approval policy with sidecar", () => {
    const { result } = compile('allow "research-bot" to [read, list, archive] on gmail.messages where { labels contains "sma/class/notification" } requires approval for [archive]');
    expect(result.sidecar.requiresApproval).toEqual(["gmail:messages:archive"]);
    expect(result.cedar).not.toContain("gmail:messages:archive");
    expect(result.cedar).toContain("gmail:messages:read");
  });

  it("compiles noaction", () => {
    const { result } = compile("noaction * on gmail.messages for 2h");
    expect(result.cedar).toContain("forbid(");
    expect(result.ast.kind).toBe("noaction");
  });

  it("returns warnings for redundant rules", () => {
    const existing = [{
      id: "p-1",
      ast: resolve(parse('allow "openclaw" to [read, list] on gmail.messages')),
    }];
    const { warnings } = compile('allow "openclaw" to [read] on gmail.messages', existing);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe("REDUNDANT_RULE");
  });

  it("throws on conflicting rules", () => {
    const existing = [{
      id: "p-1",
      ast: resolve(parse("deny * to [*] on gmail.messages")),
    }];
    expect(() =>
      compile('allow "openclaw" to [read] on gmail.messages', existing)
    ).toThrow();
  });

  it("all emitted Cedar policies pass Cedar validation", () => {
    const testCases = [
      'allow "openclaw" to [read, list] on gmail.messages where { from like "*@team.com" } for 2h',
      'deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }',
      'allow "openclaw" to [read, list] on gmail.messages where { labels contains "sma/class/work" } during weekdays(9, 17)',
      'deny * to [*] on gmail.messages where { labels contains "sma/class/finance" }',
      "noaction * on gmail.messages for 2h",
      'allow "scheduler" to [read, list] on gmail.messages where { labels contains "sma/class/calendar" } until "2026-02-28T17:00:00"',
    ];

    for (const dsl of testCases) {
      const { result } = compile(dsl);
      expect(() => validateCedar(result.cedar)).not.toThrow();
    }
  });
});

