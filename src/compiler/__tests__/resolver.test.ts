import { describe, it, expect } from "bun:test";
import { parse } from "../parser.ts";
import { resolve } from "../resolver.ts";
import { ResolveError } from "../errors.ts";

describe("resolver", () => {
  describe("resource resolution", () => {
    it("resolves gmail.messages", () => {
      const ast = parse('allow "a" to [read] on gmail.messages');
      const resolved = resolve(ast);
      expect(resolved.resource).toEqual({ service: "gmail", type: "messages" });
    });

    it("resolves gmail.threads", () => {
      const ast = parse('allow "a" to [read] on gmail.threads');
      const resolved = resolve(ast);
      expect(resolved.resource).toEqual({ service: "gmail", type: "threads" });
    });

    it("rejects unknown service", () => {
      const ast = parse('allow "a" to [read] on outlook.messages');
      expect(() => resolve(ast)).toThrow(ResolveError);
      expect(() => resolve(ast)).toThrow(/Unknown service 'outlook'/);
    });

    it("rejects unknown resource type", () => {
      const ast = parse('allow "a" to [read] on gmail.contacts');
      expect(() => resolve(ast)).toThrow(ResolveError);
      expect(() => resolve(ast)).toThrow(/Unknown resource type 'contacts'/);
    });
  });

  describe("operation resolution", () => {
    it("maps read to Cedar action", () => {
      const ast = parse('allow "a" to [read] on gmail.messages');
      const resolved = resolve(ast);
      expect(resolved.operations).toEqual(["gmail:messages:read"]);
    });

    it("maps multiple operations", () => {
      const ast = parse('allow "a" to [read, list, archive] on gmail.messages');
      const resolved = resolve(ast);
      expect(resolved.operations).toEqual([
        "gmail:messages:read",
        "gmail:messages:list",
        "gmail:messages:archive",
      ]);
    });

    it("expands wildcard to all actions", () => {
      const ast = parse('deny * to [*] on gmail.messages');
      const resolved = resolve(ast);
      expect(resolved.operations).toHaveLength(6);
      expect(resolved.operations).toContain("gmail:messages:read");
      expect(resolved.operations).toContain("gmail:messages:trash");
    });

    it("rejects unknown operations", () => {
      const ast = parse('allow "a" to [read, nuke] on gmail.messages');
      expect(() => resolve(ast)).toThrow(ResolveError);
      expect(() => resolve(ast)).toThrow(/Unknown operation 'nuke'/);
    });
  });

  describe("condition resolution", () => {
    it("resolves from attribute as String", () => {
      const ast = parse('allow "a" to [read] on gmail.messages where { from like "*@team.com" }');
      const resolved = resolve(ast);
      expect(resolved.conditions![0]!.attributeType).toBe("String");
    });

    it("resolves labels attribute as Set<String>", () => {
      const ast = parse('allow "a" to [read] on gmail.messages where { labels contains "sma/class/work" }');
      const resolved = resolve(ast);
      expect(resolved.conditions![0]!.attributeType).toBe("Set<String>");
    });

    it("resolves date attribute as Long", () => {
      const ast = parse('allow "a" to [read] on gmail.messages where { date > 1740571200 }');
      const resolved = resolve(ast);
      expect(resolved.conditions![0]!.attributeType).toBe("Long");
    });

    it("resolves to attribute as Set<String>", () => {
      const ast = parse('allow "a" to [read] on gmail.messages where { to contains "alice@co.com" }');
      const resolved = resolve(ast);
      expect(resolved.conditions![0]!.attributeType).toBe("Set<String>");
    });

    it("rejects unknown attributes", () => {
      const ast = parse('allow "a" to [read] on gmail.messages where { fron like "*@team.com" }');
      expect(() => resolve(ast)).toThrow(ResolveError);
      expect(() => resolve(ast)).toThrow(/Unknown attribute 'fron'/);
    });
  });

  describe("noaction resolution", () => {
    it("expands noaction to all Cedar actions", () => {
      const ast = parse("noaction * on gmail.messages for 2h");
      const resolved = resolve(ast);
      expect(resolved.kind).toBe("noaction");
      expect(resolved.operations).toHaveLength(6);
    });
  });

  describe("requires approval resolution", () => {
    it("resolves approval operation names to Cedar actions", () => {
      const ast = parse('allow "bot" to [read, archive] on gmail.messages requires approval for [archive]');
      const resolved = resolve(ast);
      expect(resolved.requiresApproval!.operations).toEqual(["gmail:messages:archive"]);
    });

    it("expands approval wildcard to all actions", () => {
      const ast = parse('allow "bot" to [read, send] on gmail.messages requires approval');
      const resolved = resolve(ast);
      expect(resolved.requiresApproval!.operations).toHaveLength(6);
    });
  });

  describe("passthrough fields", () => {
    it("preserves agent name", () => {
      const ast = parse('allow "openclaw" to [read] on gmail.messages');
      expect(resolve(ast).agent).toBe("openclaw");
    });

    it("preserves wildcard agent", () => {
      const ast = parse("deny * to [read] on gmail.messages");
      expect(resolve(ast).agent).toBe("*");
    });

    it("preserves time bound", () => {
      const ast = parse('allow "a" to [read] on gmail.messages for 2h');
      expect(resolve(ast).timeBound).toEqual({ kind: "duration", seconds: 7200 });
    });
  });
});
