import { Cron } from "croner";
import { overdueAfterMs, scheduleCron, type Schedule } from "@backup/shared/api/schedule";
import type { Run, RunStatus } from "@backup/shared/api/runs";
import type { SourceStatus } from "@backup/shared/api/sources";

/** The first planned time after `after`, in the time zone `timezone`. */
export function nextRunAfter(schedule: Schedule, after: Date, timezone: string): Date {
  const cron = new Cron(scheduleCron(schedule), { timezone, paused: true });
  const next = cron.nextRun(after);
  cron.stop();
  // A valid five-part pattern always has a next time; fall back to a day later just in case.
  return next ?? new Date(after.getTime() + 24 * 3_600_000);
}

/** A time of day ("04:30") as a daily schedule's next time after `after`. */
export function nextDailyAt(time: string, after: Date, timezone: string): Date {
  return nextRunAfter({ type: "daily", time }, after, timezone);
}

/**
 * A source's status from its newest run, its newest finished run and its
 * last success. A problem (failed, overdue) wins over a warning; a running
 * or planned run shows as such.
 */
export function sourceStatus(input: {
  enabled: boolean;
  schedule: Schedule;
  createdAt: Date;
  lastSuccessAt: Date | null;
  active: Pick<Run, "status"> | null;
  lastFinished: { status: RunStatus } | null;
  now: Date;
}): SourceStatus {
  if (input.active?.status === "running") return "running";
  if (input.active?.status === "queued") return "queued";
  if (!input.enabled) return "paused";
  const overdueAfter = overdueAfterMs(input.schedule);
  const since = input.lastSuccessAt ?? input.createdAt;
  const overdue = input.now.getTime() - since.getTime() > overdueAfter;
  if (input.lastFinished?.status === "failed") return "failed";
  if (overdue) return "overdue";
  if (!input.lastFinished || !input.lastSuccessAt) return "never";
  if (input.lastFinished.status === "warning") return "warning";
  return "ok";
}

/**
 * What the admins should hear about (alerts, the heartbeat): an unresolved
 * failure or an overdue backup of an enabled source, whatever runs now. A
 * queued or running backup hides neither: one long run can keep the other
 * sources waiting past their deadline.
 */
export function sourceProblem(
  input: Omit<Parameters<typeof sourceStatus>[0], "active">,
): "failed" | "overdue" | null {
  const status = sourceStatus({ ...input, active: null });
  return status === "failed" || status === "overdue" ? status : null;
}
