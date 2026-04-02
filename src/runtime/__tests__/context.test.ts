import { describe, it, expect } from "bun:test";
import { DateTime } from "luxon";
import { buildContext, buildContextAt } from "../context.ts";

describe("context builder", () => {
  const policyCreatedAt = new Date("2026-01-15T10:00:00Z");

  it("builds context with correct now timestamp", () => {
    const now = DateTime.fromISO("2026-02-01T14:30:00Z");
    const ctx = buildContextAt({ userTimezone: "UTC", policyCreatedAt }, now);

    expect(ctx.now).toBe(Math.floor(now.toSeconds()));
  });

  it("sets grantedAt from policy creation time", () => {
    const now = DateTime.fromISO("2026-02-01T14:30:00Z");
    const ctx = buildContextAt({ userTimezone: "UTC", policyCreatedAt }, now);

    expect(ctx.grantedAt).toBe(Math.floor(policyCreatedAt.getTime() / 1000));
  });

  it("computes hourOfDay in UTC", () => {
    const now = DateTime.fromISO("2026-02-01T14:30:00Z");
    const ctx = buildContextAt({ userTimezone: "UTC", policyCreatedAt }, now);

    expect(ctx.hourOfDay).toBe(14);
  });

  it("computes hourOfDay in America/New_York", () => {
    // 2026-02-01 is winter, so EST = UTC-5
    const now = DateTime.fromISO("2026-02-01T14:30:00Z");
    const ctx = buildContextAt({ userTimezone: "America/New_York", policyCreatedAt }, now);

    expect(ctx.hourOfDay).toBe(9); // 14 UTC = 9 EST
  });

  it("computes hourOfDay in Asia/Tokyo", () => {
    // JST = UTC+9
    const now = DateTime.fromISO("2026-02-01T14:30:00Z");
    const ctx = buildContextAt({ userTimezone: "Asia/Tokyo", policyCreatedAt }, now);

    expect(ctx.hourOfDay).toBe(23); // 14 + 9 = 23
  });

  it("computes dayOfWeek correctly - Monday=1", () => {
    // 2026-02-02 is a Monday
    const now = DateTime.fromISO("2026-02-02T10:00:00Z");
    const ctx = buildContextAt({ userTimezone: "UTC", policyCreatedAt }, now);

    expect(ctx.dayOfWeek).toBe(1);
  });

  it("computes dayOfWeek correctly - Sunday=7", () => {
    // 2026-02-01 is a Sunday
    const now = DateTime.fromISO("2026-02-01T10:00:00Z");
    const ctx = buildContextAt({ userTimezone: "UTC", policyCreatedAt }, now);

    expect(ctx.dayOfWeek).toBe(7);
  });

  it("computes dayOfWeek correctly - Saturday=6", () => {
    // 2026-01-31 is a Saturday
    const now = DateTime.fromISO("2026-01-31T10:00:00Z");
    const ctx = buildContextAt({ userTimezone: "UTC", policyCreatedAt }, now);

    expect(ctx.dayOfWeek).toBe(6);
  });

  it("handles timezone crossing midnight - different day", () => {
    // UTC: Wednesday 2026-02-04 at 02:00
    // US Pacific (PST): Tuesday 2026-02-03 at 18:00
    const now = DateTime.fromISO("2026-02-04T02:00:00Z");

    const utcCtx = buildContextAt({ userTimezone: "UTC", policyCreatedAt }, now);
    const pacificCtx = buildContextAt({ userTimezone: "America/Los_Angeles", policyCreatedAt }, now);

    expect(utcCtx.dayOfWeek).toBe(3); // Wednesday
    expect(pacificCtx.dayOfWeek).toBe(2); // Tuesday
    expect(utcCtx.hourOfDay).toBe(2);
    expect(pacificCtx.hourOfDay).toBe(18);
  });

  it("handles DST transition - spring forward", () => {
    // US spring forward 2026: March 8
    // At 2026-03-08T10:00:00Z:
    //   EST would be 5am, but after DST it's EDT = UTC-4 = 6am
    const now = DateTime.fromISO("2026-03-08T10:00:00Z");
    const ctx = buildContextAt({ userTimezone: "America/New_York", policyCreatedAt }, now);

    expect(ctx.hourOfDay).toBe(6); // EDT (UTC-4)
  });

  it("throws on invalid timezone", () => {
    const now = DateTime.fromISO("2026-02-01T14:30:00Z");

    expect(() =>
      buildContextAt({ userTimezone: "Invalid/Timezone", policyCreatedAt }, now),
    ).toThrow("Invalid timezone");
  });

  it("buildContext uses current time", () => {
    const ctx = buildContext({ userTimezone: "UTC", policyCreatedAt });

    // now should be close to current time (within a few seconds)
    const currentUnix = Math.floor(Date.now() / 1000);
    expect(Math.abs(ctx.now - currentUnix)).toBeLessThan(5);
  });
});
