import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import { afterEach, vi } from "vite-plus/test";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

afterEach(() => vi.unstubAllEnvs());

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("skips to the next matching cron occurrence in server-local time", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const next = nextScheduledRunAt(
      { type: "cron", expression: "0 9 * * 1-5" },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    // Friday 10:00 local; the next weekday 9:00 is Monday 09:00 PDT.
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-07-06T16:00:00.000Z");
  });

  it("computes the next cron run strictly after the reference time", () => {
    vi.stubEnv("TZ", "UTC");
    const from = DateTime.makeZonedUnsafe(
      { year: 2026, month: 11, day: 9, hour: 9, minute: 0, second: 0, millisecond: 0 },
      { timeZone: "UTC", adjustForTimeZone: true },
    );
    const next = nextScheduledRunAt({ type: "cron", expression: "0 9 * * 1" }, from);
    expect(next ? DateTime.formatIso(DateTime.toUtc(next)) : null).toBe("2026-11-16T09:00:00.000Z");
  });

  it("has no next run for undecodable or impossible cron expressions", () => {
    const from = DateTime.makeZonedUnsafe(
      { year: 2026, month: 11, day: 6, hour: 12, minute: 0, second: 0, millisecond: 0 },
      { timeZone: "UTC", adjustForTimeZone: true },
    );
    expect(nextScheduledRunAt({ type: "cron", expression: "not a cron" }, from)).toBeNull();
    expect(nextScheduledRunAt({ type: "cron", expression: "0 0 30 2 *" }, from)).toBeNull();
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-11-01T03:00:00-05:00" },
        { type: "once", runAt: "2026-11-01T08:00:00.000Z" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "cron", expression: "0 9 * * 1-5" },
        { type: "cron", expression: "0 9 * * 1,2,3,4,5" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "cron", expression: "0 9 * * 1-5" },
        { type: "cron", expression: "30 9 * * 1-5" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "cron", expression: "0 9 * * 1-5" },
        { type: "interval", everyMs: 60_000 },
      ),
    ).toBe(false);
  });
});
