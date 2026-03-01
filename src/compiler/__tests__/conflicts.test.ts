import { describe, it, expect } from "bun:test";
import { parse } from "../parser.ts";
import { resolve } from "../resolver.ts";
import { checkConflicts } from "../conflicts.ts";
import { ConflictError } from "../errors.ts";

function resolved(dsl: string) {
  return resolve(parse(dsl));
}

function existing(id: string, dsl: string) {
  return { id, ast: resolved(dsl) };
}

describe("conflict detection", () => {
  describe("shadowed allows", () => {
    it("detects allow shadowed by unconditional deny *", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages');
      const policies = [existing("p-1", "deny * to [*] on gmail.messages")];

      expect(() => checkConflicts(newPolicy, policies)).toThrow(ConflictError);
    });

    it("detects allow shadowed by deny on same agent", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages where { labels contains "sma/class/work" }');
      const policies = [existing("p-1", 'deny "openclaw" to [*] on gmail.messages')];

      expect(() => checkConflicts(newPolicy, policies)).toThrow(ConflictError);
    });

    it("does not flag allow when deny is on different agent", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages');
      const policies = [existing("p-1", 'deny "other-bot" to [*] on gmail.messages')];

      const result = checkConflicts(newPolicy, policies);
      expect(result.errors).toHaveLength(0);
    });

    it("does not flag allow when deny covers fewer operations", () => {
      const newPolicy = resolved('allow "openclaw" to [read, list] on gmail.messages');
      const policies = [existing("p-1", 'deny "openclaw" to [send] on gmail.messages')];

      const result = checkConflicts(newPolicy, policies);
      expect(result.errors).toHaveLength(0);
    });

    it("detects allow shadowed by noaction", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages');
      const policies = [existing("p-1", "noaction * on gmail.messages")];

      expect(() => checkConflicts(newPolicy, policies)).toThrow(ConflictError);
    });
  });

  describe("redundant rules", () => {
    it("detects redundant allow covered by existing broader allow", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages');
      const policies = [existing("p-1", 'allow "openclaw" to [read, list] on gmail.messages')];

      const result = checkConflicts(newPolicy, policies);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]!.code).toBe("REDUNDANT_RULE");
    });

    it("detects redundant deny covered by wildcard deny", () => {
      const newPolicy = resolved('deny "openclaw" to [read] on gmail.messages');
      const policies = [existing("p-1", "deny * to [*] on gmail.messages")];

      const result = checkConflicts(newPolicy, policies);
      expect(result.warnings).toHaveLength(1);
    });

    it("does not flag non-redundant policies", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages where { from like "*@team.com" }');
      const policies = [existing("p-1", 'allow "openclaw" to [read] on gmail.messages where { from like "*@other.com" }')];

      const result = checkConflicts(newPolicy, policies);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("no conflicts", () => {
    it("passes with empty existing policies", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages');
      const result = checkConflicts(newPolicy, []);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it("passes with unrelated policies", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages where { labels contains "sma/class/work" }');
      const policies = [
        existing("p-1", 'allow "other-bot" to [draft] on gmail.messages'),
        existing("p-2", 'deny * to [*] on gmail.messages where { labels contains "sma/class/auth" }'),
      ];

      const result = checkConflicts(newPolicy, policies);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("error structure", () => {
    it("includes policy ID in error", () => {
      const newPolicy = resolved('allow "openclaw" to [read] on gmail.messages');
      const policies = [existing("policy-xyz", "deny * to [*] on gmail.messages")];

      try {
        checkConflicts(newPolicy, policies);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ConflictError);
        const err = e as ConflictError;
        expect(err.issues[0]!.existingPolicyId).toBe("policy-xyz");
      }
    });
  });
});
