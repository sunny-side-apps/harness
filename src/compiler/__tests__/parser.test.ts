import { describe, it, expect } from "bun:test";
import { parse } from "../parser.ts";
import { ParseError } from "../errors.ts";

describe("parser", () => {
  describe("allow rules", () => {
    it("parses basic allow with quoted agent", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages');
      expect(ast.kind).toBe("allow");
      expect(ast.agent).toBe("openclaw");
      expect(ast.operations).toEqual(["read"]);
      expect(ast.resource).toEqual({ service: "gmail", type: "messages" });
    });

    it("parses allow with multiple operations", () => {
      const ast = parse('allow "openclaw" to [read, list, archive] on gmail.messages');
      expect(ast.operations).toEqual(["read", "list", "archive"]);
    });

    it("parses allow with wildcard operations", () => {
      const ast = parse('allow "openclaw" to [*] on gmail.messages');
      expect(ast.operations).toEqual(["*"]);
    });

    it("parses allow with wildcard agent", () => {
      const ast = parse("deny * to [*] on gmail.messages");
      expect(ast.agent).toBe("*");
    });

    it("parses allow with where clause", () => {
      const ast = parse('allow "openclaw" to [read, list] on gmail.messages where { from like "*@team.com" }');
      expect(ast.conditions).toHaveLength(1);
      expect(ast.conditions![0]).toEqual({
        attribute: "from",
        operator: "like",
        value: "*@team.com",
      });
    });

    it("parses allow with contains operator", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages where { labels contains "sma/class/work" }');
      expect(ast.conditions![0]).toEqual({
        attribute: "labels",
        operator: "contains",
        value: "sma/class/work",
      });
    });

    it("parses allow with multiple conditions", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages where { from like "*@team.com", labels contains "sma/class/work" }');
      expect(ast.conditions).toHaveLength(2);
      expect(ast.conditions![0]!.attribute).toBe("from");
      expect(ast.conditions![1]!.attribute).toBe("labels");
    });

    it("parses allow with equality operator", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages where { from == "alice@team.com" }');
      expect(ast.conditions![0]).toEqual({
        attribute: "from",
        operator: "==",
        value: "alice@team.com",
      });
    });

    it("parses allow with numeric condition", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages where { date > 1740571200 }');
      expect(ast.conditions![0]).toEqual({
        attribute: "date",
        operator: ">",
        value: 1740571200,
      });
    });
  });

  describe("time bounds", () => {
    it("parses for duration (hours)", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages for 2h');
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 7200 });
    });

    it("parses for duration (minutes)", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages for 30m');
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 1800 });
    });

    it("parses for duration (days)", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages for 1d');
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 86400 });
    });

    it("parses for session", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages for session');
      expect(ast.timeBound).toEqual({ kind: "session" });
    });

    it("parses until timestamp", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages until "2026-03-01T00:00:00"');
      expect(ast.timeBound).toEqual({ kind: "until", timestamp: "2026-03-01T00:00:00" });
    });

    it("parses during weekdays with hours", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages during weekdays(9, 17)');
      expect(ast.timeBound).toEqual({
        kind: "schedule",
        schedule: { days: "weekdays", startHour: 9, endHour: 17 },
      });
    });

    it("parses during weekends", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages during weekends(10, 18)');
      expect(ast.timeBound).toEqual({
        kind: "schedule",
        schedule: { days: "weekends", startHour: 10, endHour: 18 },
      });
    });

    it("parses during everyday", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages during everyday(8, 20)');
      expect(ast.timeBound).toEqual({
        kind: "schedule",
        schedule: { days: "everyday", startHour: 8, endHour: 20 },
      });
    });
  });

  describe("requires approval", () => {
    it("parses requires approval for specific operations", () => {
      const ast = parse('allow "research-bot" to [read, list, archive] on gmail.messages requires approval for [archive]');
      expect(ast.requiresApproval).toEqual({ operations: ["archive"] });
    });

    it("parses requires approval for all operations", () => {
      const ast = parse('allow "bot" to [read, send] on gmail.messages requires approval');
      expect(ast.requiresApproval).toEqual({ operations: ["*"] });
    });

    it("rejects requires approval on deny rules", () => {
      expect(() =>
        parse('deny "bot" to [read] on gmail.messages requires approval')
      ).toThrow(ParseError);
    });
  });

  describe("deny rules", () => {
    it("parses basic deny", () => {
      const ast = parse('deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }');
      expect(ast.kind).toBe("deny");
      expect(ast.agent).toBe("*");
      expect(ast.operations).toEqual(["*"]);
      expect(ast.conditions![0]).toEqual({
        attribute: "labels",
        operator: "contains",
        value: "sma/class/auth",
      });
    });

    it("parses deny with time bound", () => {
      const ast = parse('deny "bot" to [send] on gmail.messages for 2h');
      expect(ast.kind).toBe("deny");
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 7200 });
    });
  });

  describe("noaction rules", () => {
    it("parses noaction with duration", () => {
      const ast = parse("noaction * on gmail.messages for 2h");
      expect(ast.kind).toBe("noaction");
      expect(ast.agent).toBe("*");
      expect(ast.operations).toEqual(["*"]);
      expect(ast.resource).toEqual({ service: "gmail", type: "messages" });
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 7200 });
    });

    it("parses noaction with specific agent", () => {
      const ast = parse('noaction "openclaw" on gmail.messages for 90m');
      expect(ast.agent).toBe("openclaw");
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 5400 });
    });

    it("parses noaction without time bound", () => {
      const ast = parse("noaction * on gmail.messages");
      expect(ast.kind).toBe("noaction");
      expect(ast.timeBound).toBeUndefined();
    });

    it("parses noaction with session", () => {
      const ast = parse("noaction * on gmail.messages for session");
      expect(ast.timeBound).toEqual({ kind: "session" });
    });
  });

  describe("full examples from DSL.md", () => {
    it("parses: allow openclaw read team emails for 2h", () => {
      const ast = parse('allow "openclaw" to [read, list] on gmail.messages where { from like "*@team.com" } for 2h');
      expect(ast.kind).toBe("allow");
      expect(ast.agent).toBe("openclaw");
      expect(ast.operations).toEqual(["read", "list"]);
      expect(ast.conditions![0]).toEqual({ attribute: "from", operator: "like", value: "*@team.com" });
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 7200 });
    });

    it("parses: deny all agents from auth emails", () => {
      const ast = parse('deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }');
      expect(ast.kind).toBe("deny");
      expect(ast.agent).toBe("*");
      expect(ast.operations).toEqual(["*"]);
    });

    it("parses: openclaw read work emails during business hours", () => {
      const ast = parse('allow "openclaw" to [read, list] on gmail.messages where { labels contains "sma/class/work" } during weekdays(9, 17)');
      expect(ast.kind).toBe("allow");
      expect(ast.conditions![0]!.value).toBe("sma/class/work");
      expect(ast.timeBound).toEqual({ kind: "schedule", schedule: { days: "weekdays", startHour: 9, endHour: 17 } });
    });

    it("parses: research-bot read notifications, approval for archive", () => {
      const ast = parse('allow "research-bot" to [read, list, archive] on gmail.messages where { labels contains "sma/class/notification" } requires approval for [archive]');
      expect(ast.operations).toEqual(["read", "list", "archive"]);
      expect(ast.requiresApproval).toEqual({ operations: ["archive"] });
    });

    it("parses: scheduler read calendar until timestamp", () => {
      const ast = parse('allow "scheduler" to [read, list] on gmail.messages where { labels contains "sma/class/calendar" } until "2026-02-28T17:00:00"');
      expect(ast.timeBound).toEqual({ kind: "until", timestamp: "2026-02-28T17:00:00" });
    });

    it("parses: noaction all agents for 2h", () => {
      const ast = parse("noaction * on gmail.messages for 2h");
      expect(ast.kind).toBe("noaction");
      expect(ast.agent).toBe("*");
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 7200 });
    });
  });

  describe("combined clauses (where + time)", () => {
    it("parses where before time", () => {
      const ast = parse('allow "a" to [read] on gmail.messages where { from == "x@y.com" } for 1h');
      expect(ast.conditions).toHaveLength(1);
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 3600 });
    });

    it("parses time before where", () => {
      const ast = parse('allow "a" to [read] on gmail.messages for 1h where { from == "x@y.com" }');
      expect(ast.conditions).toHaveLength(1);
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 3600 });
    });

    it("parses where + time + requires approval", () => {
      const ast = parse('allow "a" to [read, send] on gmail.messages where { from == "x@y.com" } for 1h requires approval for [send]');
      expect(ast.conditions).toHaveLength(1);
      expect(ast.timeBound).toEqual({ kind: "duration", seconds: 3600 });
      expect(ast.requiresApproval).toEqual({ operations: ["send"] });
    });
  });

  describe("error cases", () => {
    it("throws on empty input", () => {
      expect(() => parse("")).toThrow(ParseError);
    });

    it("throws on unknown keyword", () => {
      expect(() => parse("grant agent to [read] on gmail.messages")).toThrow(ParseError);
    });

    it("throws on missing operation list", () => {
      expect(() => parse('allow "a" to on gmail.messages')).toThrow(ParseError);
    });

    it("throws on unterminated string", () => {
      expect(() => parse('allow "unclosed to [read] on gmail.messages')).toThrow(ParseError);
    });

    it("throws on duplicate where clause", () => {
      expect(() =>
        parse('allow "a" to [read] on gmail.messages where { from == "x" } where { to contains "y" }')
      ).toThrow(ParseError);
    });

    it("throws on duplicate time bound", () => {
      expect(() =>
        parse('allow "a" to [read] on gmail.messages for 1h for 2h')
      ).toThrow(ParseError);
    });

    it("throws on invalid duration format", () => {
      expect(() =>
        parse('allow "a" to [read] on gmail.messages for 2x')
      ).toThrow(ParseError);
    });
  });
});
