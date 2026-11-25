import { writeFile } from "node:fs/promises";
import { config } from "../config";
import { getDb } from "../db/client";
import { logger } from "../logger";
import { monitored } from "../error-reporting";
import { pruneAuditLog } from "../core/audit";
import { pruneRunHistory } from "../runs/service";
import { checkAlerts } from "../alerts/notify";
import { executeNext, failInterruptedRuns } from "./execute";
import { expireAgentRuns, planRuns } from "./scheduler";

export type Stop = () => Promise<void>;

/** A repeating job; `hung` tells whether its current run takes far longer than it ever should. */
export type Scheduled = { name: string; stop: Stop; hung: () => boolean };

/**
 * Repeats a job every `minutes`, first after `firstDelayMs`; errors are
 * logged, never thrown. A run longer than `maxRunMinutes` counts as hung.
 */
export function every(
  schedule: { name: string; minutes: number; firstDelayMs: number; maxRunMinutes: number },
  job: () => Promise<unknown>,
): Scheduled {
  const { name } = schedule;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let startedAt: number | undefined;
  let stopped = false;
  const run = () => {
    startedAt = Date.now();
    running = job()
      .catch((error: unknown) => logger.error({ err: error, task: name }, "scheduled job failed"))
      .finally(() => {
        running = undefined;
        startedAt = undefined;
        if (!stopped) timer = setTimeout(run, schedule.minutes * 60_000);
      });
  };
  timer = setTimeout(run, schedule.firstDelayMs);
  return {
    name,
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
    hung: () => startedAt !== undefined && Date.now() - startedAt > schedule.maxRunMinutes * 60_000,
  };
}

/**
 * Calls `touch` every 5 seconds while no job hangs, so a health check of the
 * heartbeat file notices a worker whose event loop or jobs are stuck.
 */
export function startHeartbeat(jobs: Scheduled[], touch: () => unknown): () => void {
  let reported = false;
  const beat = () => {
    const hung = jobs.find((job) => job.hung());
    if (hung) {
      if (!reported) logger.error({ task: hung.name }, "scheduled job hangs; heartbeat stopped");
      reported = true;
      return;
    }
    reported = false;
    touch();
  };
  beat();
  const interval = setInterval(beat, 5_000);
  return () => clearInterval(interval);
}

/**
 * The worker: plans runs from the schedules, executes Google Drive,
 * Personio and this app's own backups and the daily upkeep one at a time,
 * ends agent jobs nobody picked up, and sends alerts and heartbeats.
 */
export async function startWorker(): Promise<Stop> {
  const db = getDb();
  await failInterruptedRuns(db, "restart");
  // Stops the run that executes when the worker stops; a scheduled one is queued again.
  const stopping = new AbortController();
  const jobs = [
    every({ name: "plan", minutes: 0.5, firstDelayMs: 2_000, maxRunMinutes: 10 }, async () => {
      await planRuns(db);
      await expireAgentRuns(db);
    }),
    // One run at a time; a long Google Drive copy may take many hours.
    every({ name: "execute", minutes: 0.25, firstDelayMs: 5_000, maxRunMinutes: 48 * 60 }, async () => {
      while (await executeNext(db, stopping.signal)) {
        // The next queued run, if any.
      }
    }),
    every({ name: "alerts", minutes: 1, firstDelayMs: 30_000, maxRunMinutes: 10 }, () =>
      monitored("backups-alerts", { minutes: 1 }, () => checkAlerts(db)),
    ),
    every({ name: "housekeeping", minutes: 60, firstDelayMs: 60_000, maxRunMinutes: 30 }, async () => {
      await pruneRunHistory(db);
      await pruneAuditLog(db, config().AUDIT_LOG_DAYS);
    }),
  ];
  const heartbeat = config().WORKER_HEARTBEAT_FILE;
  const stopHeartbeat = heartbeat
    ? startHeartbeat(jobs, () => void writeFile(heartbeat, "").catch(() => undefined))
    : undefined;
  logger.info("worker started");
  return async () => {
    stopping.abort();
    stopHeartbeat?.();
    await Promise.all(jobs.map((job) => job.stop()));
  };
}
