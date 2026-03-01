import { describe, it, expect, beforeEach, mock } from "bun:test";
import { mdc, withMdc, setMdc, hrtimeToNs, createChildLogger, logger } from "../logger.ts";

describe("logger", () => {
  describe("logger instance", () => {
    it("exists and has standard log methods", () => {
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.debug).toBe("function");
    });
  });

  describe("createChildLogger", () => {
    it("creates a child with component binding", () => {
      const child = createChildLogger("compiler");
      expect(child).toBeDefined();
      expect(typeof child.info).toBe("function");
    });

    it("creates a child with extra bindings", () => {
      const child = createChildLogger("api", { port: 3000 });
      expect(child).toBeDefined();
    });
  });

  describe("MDC", () => {
    it("provides empty store outside of run context", () => {
      const store = mdc.getCopyOfStore();
      // Outside of run(), store may be undefined or empty
      expect(store === undefined || Object.keys(store).length === 0).toBe(true);
    });

    it("propagates context within withMdc", () => {
      withMdc({ "http.request_id": "req-123", agent_id: "agent-1" }, () => {
        expect(mdc.get("http.request_id")).toBe("req-123");
        expect(mdc.get("agent_id")).toBe("agent-1");
      });
    });

    it("isolates context between withMdc calls", () => {
      withMdc({ user_id: "user-a" }, () => {
        expect(mdc.get("user_id")).toBe("user-a");
      });

      withMdc({ user_id: "user-b" }, () => {
        expect(mdc.get("user_id")).toBe("user-b");
      });
    });

    it("allows setMdc to add fields within a context", () => {
      withMdc({ "http.request_id": "req-456" }, () => {
        setMdc("policy_id", "pol-1");
        expect(mdc.get("policy_id")).toBe("pol-1");
        expect(mdc.get("http.request_id")).toBe("req-456");
      });
    });

    it("supports nested withMdc calls", () => {
      withMdc({ "http.request_id": "req-outer" }, () => {
        expect(mdc.get("http.request_id")).toBe("req-outer");

        withMdc({ "http.request_id": "req-inner", agent_id: "agent-2" }, () => {
          expect(mdc.get("http.request_id")).toBe("req-inner");
          expect(mdc.get("agent_id")).toBe("agent-2");
        });
      });
    });
  });

  describe("hrtimeToNs", () => {
    it("returns nanoseconds from hrtime diff", () => {
      const start = process.hrtime();
      // Small busy loop to ensure measurable time
      let sum = 0;
      for (let i = 0; i < 10000; i++) sum += i;
      const ns = hrtimeToNs(start);
      expect(ns).toBeGreaterThan(0);
      expect(typeof ns).toBe("number");
    });

    it("returns a reasonable magnitude", () => {
      const start = process.hrtime();
      const ns = hrtimeToNs(start);
      // Should be less than 1 second (1e9 ns) for an immediate call
      expect(ns).toBeLessThan(1_000_000_000);
    });
  });
});
