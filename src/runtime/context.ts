import type { PolicyContext } from "@shared/types.ts";
import { DateTime } from "luxon";
import { ContextBuildError } from "./errors.ts";

export type ContextInput = {
  userTimezone: string;
  policyCreatedAt: Date;
};

export function buildContext(input: ContextInput): PolicyContext {
  return buildContextAt(input, DateTime.now());
}

export function buildContextAt(input: ContextInput, now: DateTime): PolicyContext {
  const userNow = now.setZone(input.userTimezone);

  if (!userNow.isValid) {
    throw new ContextBuildError(
      `Invalid timezone: ${input.userTimezone}`,
      input.userTimezone,
    );
  }

  return {
    now: Math.floor(now.toSeconds()),
    grantedAt: Math.floor(input.policyCreatedAt.getTime() / 1000),
    hourOfDay: userNow.hour,
    dayOfWeek: userNow.weekday, // 1=Mon, 7=Sun (ISO)
  };
}
