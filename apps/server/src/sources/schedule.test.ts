import { describe, expect, it } from "vitest";
import { overdueAfterMs, scheduleCron } from "@backup/shared/api/schedule";
import { nextRunAfter, sourceStatus } from "./schedule";

describe("schedules", () => {
  it("turns schedules into cron expressions", () => {
    expect(scheduleCron({ type: "hourly", every: 1, minute: 5 })).toBe("5 * * * *");
    expect(scheduleCron({ type: "hourly", every: 6, minute: 0 })).toBe("0 */6 * * *");
    expect(scheduleCron({ type: "daily", time: "02:30" })).toBe("30 2 * * *");
    expect(scheduleCron({ type: "weekly", day: 0, time: "23:05" })).toBe("5 23 * * 0");
  });

  it("plans in the server's time zone, also across daylight saving time", () => {
    const daily = { type: "daily" as const, time: "02:30" };
    expect(nextRunAfter(daily, new Date("2026-11-20T10:00:00Z"), "Europe/Berlin").toISOString()).toBe(
      "2026-11-21T01:30:00.000Z",
    );
    // Summer time in Berlin is UTC+2.
    expect(nextRunAfter(daily, new Date("2026-07-01T10:00:00Z"), "Europe/Berlin").toISOString()).toBe(
      "2026-07-02T00:30:00.000Z",
    );
    expect(
      nextRunAfter(
        { type: "weekly", day: 1, time: "04:00" },
        new Date("2026-11-20T10:00:00Z"),
        "UTC",
      ).toISOString(),
    ).toBe("2026-11-23T04:00:00.000Z");
  });

  it("derives a source's status", () => {
    const schedule = { type: "daily" as const, time: "02:00" };
    const now = new Date("2026-11-20T12:00:00Z");
    const base = { enabled: true, schedule, createdAt: new Date("2026-11-01T00:00:00Z"), now };
    const recent = new Date("2026-11-20T02:05:00Z");
    expect(
      sourceStatus({ ...base, lastSuccessAt: recent, active: null, lastFinished: { status: "succeeded" } }),
    ).toBe("ok");
    expect(
      sourceStatus({ ...base, lastSuccessAt: recent, active: null, lastFinished: { status: "warning" } }),
    ).toBe("warning");
    expect(
      sourceStatus({ ...base, lastSuccessAt: recent, active: null, lastFinished: { status: "failed" } }),
    ).toBe("failed");
    expect(
      sourceStatus({ ...base, lastSuccessAt: recent, active: { status: "running" }, lastFinished: null }),
    ).toBe("running");
    expect(
      sourceStatus({ ...base, enabled: false, lastSuccessAt: recent, active: null, lastFinished: null }),
    ).toBe("paused");
    const old = new Date(now.getTime() - overdueAfterMs(schedule) - 1000);
    expect(
      sourceStatus({ ...base, lastSuccessAt: old, active: null, lastFinished: { status: "succeeded" } }),
    ).toBe("overdue");
    expect(
      sourceStatus({
        ...base,
        createdAt: new Date("2026-11-20T11:00:00Z"),
        lastSuccessAt: null,
        active: null,
        lastFinished: null,
      }),
    ).toBe("never");
    expect(sourceStatus({ ...base, lastSuccessAt: null, active: null, lastFinished: null })).toBe("overdue");
  });
});
