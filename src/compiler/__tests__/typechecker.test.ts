import { describe, it, expect } from "bun:test";
import { parse } from "../parser.ts";
import { resolve } from "../resolver.ts";
import { typecheck } from "../typechecker.ts";
import { TypecheckError } from "../errors.ts";

function check(dsl: string) {
  const ast = parse(dsl);
  const resolved = resolve(ast);
  typecheck(resolved);
  return resolved;
}

describe("typechecker", () => {
  describe("valid conditions", () => {
    it("accepts String == String", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { from == "x@y.com" }')).not.toThrow();
    });

    it("accepts String like String", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { from like "*@team.com" }')).not.toThrow();
    });

    it("accepts String != String", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { subject != "spam" }')).not.toThrow();
    });

    it("accepts String startsWith String", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { from startsWith "admin" }')).not.toThrow();
    });

    it("accepts String endsWith String", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { from endsWith "@co.com" }')).not.toThrow();
    });

    it("accepts Set<String> contains String", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { labels contains "sma/class/work" }')).not.toThrow();
    });

    it("accepts Long > Number", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { date > 1740571200 }')).not.toThrow();
    });

    it("accepts Long == Number", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { date == 1740571200 }')).not.toThrow();
    });

    it("accepts no conditions (passes trivially)", () => {
      expect(() => check('allow "a" to [read] on gmail.messages')).not.toThrow();
    });
  });

  describe("invalid operator for type", () => {
    it("rejects contains on String (from)", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { from contains "x" }'))
        .toThrow(TypecheckError);
    });

    it("rejects > on String (from)", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { from > "x" }'))
        .toThrow(TypecheckError);
    });

    it("rejects like on Set<String> (labels)", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { labels like "*work*" }'))
        .toThrow(TypecheckError);
    });

    it("rejects like on Long (date)", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { date like "2026" }'))
        .toThrow(TypecheckError);
    });
  });

  describe("actionable error messages", () => {
    it("suggests like for contains on String", () => {
      try {
        check('allow "a" to [read] on gmail.messages where { from contains "x" }');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(TypecheckError);
        expect((e as TypecheckError).message).toContain("Did you mean 'like'");
      }
    });

    it("suggests contains for == on Set<String>", () => {
      try {
        check('allow "a" to [read] on gmail.messages where { labels == "work" }');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(TypecheckError);
        expect((e as TypecheckError).message).toContain("Did you mean 'contains'");
      }
    });

    it("lists valid operators in error", () => {
      try {
        check('allow "a" to [read] on gmail.messages where { from > "x" }');
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(TypecheckError);
        expect((e as TypecheckError).message).toContain("Valid operators:");
      }
    });
  });

  describe("value type checking", () => {
    it("rejects numeric value for String attribute", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { from == 123 }'))
        .toThrow(TypecheckError);
    });

    it("rejects string value for Long attribute", () => {
      expect(() => check('allow "a" to [read] on gmail.messages where { date > "yesterday" }'))
        .toThrow(TypecheckError);
    });
  });
});
