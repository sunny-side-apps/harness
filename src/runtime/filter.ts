import type {
  GmailMessage,
  GmailMessageAttributes,
  CedarAction,
} from "@shared/types.ts";
import { RequestEngine, type EvaluationContext, type RequestContext } from "./engine.ts";
import { createChildLogger } from "@shared/logger.ts";

const log = createChildLogger("runtime:filter");

// ─── Types ──────────────────────────────────────────────────────────────────

export type FilterResult = {
  allowed: GmailMessage[];
  filteredCount: number;
  shouldOverfetch: boolean;
};

export type FilterContext = {
  agentId: string;
  agentName: string;
  sessionId: string | null;
  userTimezone: string;
  requestedLimit: number;
  currentRound: number; // 0, 1, 2 — max 3 rounds
};

const MAX_OVERFETCH_ROUNDS = 3;

// ─── PostFetchFilter ────────────────────────────────────────────────────────

export class PostFetchFilter {
  constructor(private requestEngine: RequestEngine) {}

  async filter(
    messages: GmailMessage[],
    action: CedarAction,
    context: FilterContext,
    evalContext: EvaluationContext,
  ): Promise<FilterResult> {
    const allowed: GmailMessage[] = [];
    let filteredCount = 0;

    const requestContext: RequestContext = {
      agentId: context.agentId,
      agentName: context.agentName,
      sessionId: context.sessionId,
      userTimezone: context.userTimezone,
    };

    for (const msg of messages) {
      const attrs = extractAttributes(msg);
      const decision = this.requestEngine.evaluate(
        action,
        attrs,
        requestContext,
        evalContext,
      );

      if (decision.effect === "permit") {
        allowed.push(msg);
      } else {
        filteredCount++;
      }
    }

    const shouldOverfetch =
      allowed.length < context.requestedLimit &&
      context.currentRound < MAX_OVERFETCH_ROUNDS;

    if (filteredCount > 0) {
      log.info(
        {
          agentId: context.agentId,
          action,
          total: messages.length,
          allowed: allowed.length,
          filtered: filteredCount,
          round: context.currentRound,
          shouldOverfetch,
        },
        "Post-fetch filtering complete",
      );
    }

    return { allowed, filteredCount, shouldOverfetch };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function extractAttributes(msg: GmailMessage): GmailMessageAttributes {
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    labels: msg.labels,
    date: msg.date,
  };
}
