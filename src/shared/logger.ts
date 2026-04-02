import pino from "pino";
import { MDC } from "@blueground/async-mdc";

// ─── MDC Store ──────────────────────────────────────────────────────────────

export type MdcStore = {
  "http.request_id"?: string;
  agent_id?: string;
  user_id?: string;
  policy_id?: string;
  workflow_run_id?: string;
  correlation_id?: string;
  trace_id?: string;
};

export const mdc = new MDC<MdcStore>();

// ─── Logger Setup ───────────────────────────────────────────────────────────

const NODE_ENV = process.env.NODE_ENV ?? "development";
const isDev = NODE_ENV === "development";
const logLevel = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

function createLogger(): pino.Logger {
  const baseBindings = {
    service: "save-my-ass",
    env: NODE_ENV,
    version: process.env.npm_package_version ?? "0.0.0",
  };

  const options: pino.LoggerOptions = {
    level: logLevel,
    base: baseBindings,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        // Datadog uses `status` for severity
        return { status: label };
      },
    },
    mixin() {
      // Inject MDC context into every log line
      const store = mdc.getCopyOfStore();
      const context: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(store)) {
        if (value !== undefined) {
          context[key] = value;
        }
      }
      return context;
    },
  };

  if (isDev) {
    return pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: { colorize: true },
      },
    });
  }

  return pino(options);
}

export const logger = createLogger();

// ─── Child Logger Factory ───────────────────────────────────────────────────

/** Create a child logger with static bindings for a specific component. */
export function createChildLogger(component: string, bindings?: Record<string, unknown>): pino.Logger {
  return logger.child({ component, ...bindings });
}

// ─── MDC Helpers ────────────────────────────────────────────────────────────

/** Run a callback with MDC context seeded. All logs within the callback include the context. */
export function withMdc<R>(store: MdcStore, fn: () => R): R {
  return mdc.run(store as MdcStore, fn);
}

/** Seed MDC fields into the current context (must be inside a withMdc callback). */
export function setMdc<K extends keyof MdcStore>(key: K, value: MdcStore[K]): void {
  mdc.safeSet(key, value);
}

// ─── Duration Helper ────────────────────────────────────────────────────────

/** Convert hrtime diff to nanoseconds (Datadog standard for `duration` fields). */
export function hrtimeToNs(start: [number, number]): number {
  const [s, ns] = process.hrtime(start);
  return s * 1_000_000_000 + ns;
}
