import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db/client";
import { runs, sources } from "../db/schema";
import { logger } from "../logger";
import { readSetting, writeSetting } from "../core/settings";
import { activeRunOf, createRun } from "../runs/service";
import { nextDailyAt, nextRunAfter } from "../sources/schedule";
import { maintenanceTime } from "../target/target";

/** An agent's job waits this long for the agent to ask for it. */
export const AGENT_PICKUP_MS = 2 * 3_600_000;
/** A running upload without a part for this long has lost its web process (a little more than its own timeout). */
const AGENT_STALE_MS = 65 * 60_000;

export const UPKEEP_SCHEDULE_KEY = "upkeep_schedule";
type UpkeepSchedule = { nextAt: string; time: string };

/**
 * Plans runs: each enabled source whose time came gets a queued backup
 * (unless one is queued or running), and the daily upkeep gets a backup of
 * this app's own database followed by the repository's upkeep.
 */
export async function planRuns(db: Db, now = new Date()) {
  const due = await db
    .select()
    .from(sources)
    .where(and(eq(sources.enabled, true), or(isNull(sources.nextRunAt), lte(sources.nextRunAt, now))));
  for (const source of due) {
    const next = nextRunAfter(source.schedule, now, config().TZ);
    if (source.nextRunAt !== null && !(await activeRunOf(db, source.id))) {
      await createRun(db, { kind: "backup", sourceId: source.id, trigger: "schedule" });
      logger.info({ sourceId: source.id }, "backup planned");
    }
    await db.update(sources).set({ nextRunAt: next }).where(eq(sources.id, source.id));
  }

  const time = await maintenanceTime(db);
  const upkeep = await readSetting<UpkeepSchedule>(db, UPKEEP_SCHEDULE_KEY);
  if (!upkeep || upkeep.time !== time) {
    await writeSetting(db, UPKEEP_SCHEDULE_KEY, {
      time,
      nextAt: nextDailyAt(time, now, config().TZ).toISOString(),
    });
    return;
  }
  if (new Date(upkeep.nextAt) <= now) {
    await queueUpkeep(db, "schedule");
    await writeSetting(db, UPKEEP_SCHEDULE_KEY, {
      time,
      nextAt: nextDailyAt(time, now, config().TZ).toISOString(),
    });
  }
}

/** Queues this app's own backup and the upkeep, unless they are queued already. */
export async function queueUpkeep(db: Db, trigger: "schedule" | "manual") {
  const active = await db
    .select({ kind: runs.kind })
    .from(runs)
    .where(and(inArray(runs.kind, ["self", "maintenance"]), inArray(runs.status, ["queued", "running"])));
  const kinds = new Set(active.map((row) => row.kind));
  if (!kinds.has("self")) await createRun(db, { kind: "self", sourceId: null, trigger });
  if (!kinds.has("maintenance")) return createRun(db, { kind: "maintenance", sourceId: null, trigger });
  const [existing] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.kind, "maintenance"), inArray(runs.status, ["queued", "running"])))
    .orderBy(asc(runs.queuedAt))
    .limit(1);
  return existing!;
}

/** Ends agent jobs that were never picked up, or whose upload stopped without its web process noticing. */
export async function expireAgentRuns(db: Db, now = new Date()) {
  const appSources = db.select({ id: sources.id }).from(sources).where(eq(sources.kind, "app"));
  const notPickedUp = await db
    .update(runs)
    .set({
      status: "failed",
      finishedAt: sql`now()`,
      error:
        "The agent did not ask for the job within 2 hours. Check that the app's backup-agent service runs with BACKUP_URL and BACKUP_TOKEN.",
    })
    .where(
      and(
        eq(runs.kind, "backup"),
        eq(runs.status, "queued"),
        inArray(runs.sourceId, appSources),
        lt(runs.queuedAt, new Date(now.getTime() - AGENT_PICKUP_MS)),
      ),
    )
    .returning({ id: runs.id });
  const stale = await db
    .update(runs)
    .set({ status: "failed", finishedAt: sql`now()`, error: "The agent stopped sending" })
    .where(
      and(
        eq(runs.kind, "backup"),
        eq(runs.status, "running"),
        inArray(runs.sourceId, appSources),
        sql`(${runs.upload}->>'lastActivityAt')::timestamptz < ${new Date(now.getTime() - AGENT_STALE_MS).toISOString()}`,
      ),
    )
    .returning({ id: runs.id });
  if (notPickedUp.length + stale.length > 0) {
    logger.warn({ count: notPickedUp.length + stale.length }, "agent jobs expired");
  }
}
