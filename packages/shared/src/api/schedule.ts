import { z } from "zod";
import { timeOfDaySchema } from "./common";

/*
 * When a source is backed up, in the server's time zone (TZ), and how many
 * snapshots it keeps. The server turns a schedule into a cron expression
 * (`scheduleCron`).
 */

export const HOURLY_STEPS = [1, 2, 3, 4, 6, 8, 12] as const;

export const scheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hourly"),
    /** Every this many hours, starting at midnight. */
    every: z.union(HOURLY_STEPS.map((step) => z.literal(step))),
    /** Minute of the hour. */
    minute: z.number().int().min(0).max(59),
  }),
  z.object({ type: z.literal("daily"), time: timeOfDaySchema }),
  z.object({
    type: z.literal("weekly"),
    /** 0 = Sunday … 6 = Saturday. */
    day: z.number().int().min(0).max(6),
    time: timeOfDaySchema,
  }),
]);
export type Schedule = z.infer<typeof scheduleSchema>;

export const DEFAULT_SCHEDULE: Schedule = { type: "daily", time: "02:00" };

/** The cron expression (minute hour day-of-month month day-of-week) of a schedule. */
export function scheduleCron(schedule: Schedule): string {
  if (schedule.type === "hourly") {
    return `${schedule.minute} ${schedule.every === 1 ? "*" : `*/${schedule.every}`} * * *`;
  }
  const [hour, minute] = schedule.time.split(":").map(Number);
  return schedule.type === "daily" ? `${minute} ${hour} * * *` : `${minute} ${hour} * * ${schedule.day}`;
}

/** The time between two planned runs, in milliseconds. */
export function scheduleIntervalMs(schedule: Schedule): number {
  const hour = 3_600_000;
  if (schedule.type === "hourly") return schedule.every * hour;
  return schedule.type === "daily" ? 24 * hour : 7 * 24 * hour;
}

/**
 * How long after the last successful backup a source counts as overdue:
 * one and a half intervals plus an hour for the run itself.
 */
export function overdueAfterMs(schedule: Schedule): number {
  return Math.round(scheduleIntervalMs(schedule) * 1.5) + 3_600_000;
}

/**
 * Snapshots a source keeps (restic forget): the newest of each of the last
 * N days, weeks, months and years. The newest snapshot is always kept.
 */
export const retentionSchema = z
  .object({
    daily: z.number().int().min(0).max(366),
    weekly: z.number().int().min(0).max(520),
    monthly: z.number().int().min(0).max(240),
    yearly: z.number().int().min(0).max(100),
  })
  .refine((value) => value.daily + value.weekly + value.monthly + value.yearly > 0, {
    message: "Keep at least one snapshot",
    path: ["daily"],
  });
export type Retention = z.infer<typeof retentionSchema>;

export const DEFAULT_RETENTION: Retention = { daily: 14, weekly: 8, monthly: 12, yearly: 0 };
