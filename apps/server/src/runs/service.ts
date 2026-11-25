import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { Run, RunDetail, RunKind, RunStats, RunStatus } from "@backup/shared/api/runs";
import type { DbOrTx } from "../db/client";
import { runs, sources } from "../db/schema";
import { config } from "../config";

/** Lines a run's log keeps; the first and the newest stay when it grows. */
export const LOG_LIMIT = 400;

export const SELF_NAME = "Backup";
export const MAINTENANCE_NAME = "Repository upkeep";

type RunRow = typeof runs.$inferSelect;

export function runView(row: RunRow, sourceName: string | null, sourceKind: string | null = null): Run {
  return {
    id: row.id,
    kind: row.kind as RunKind,
    sourceId: row.sourceId,
    sourceName:
      row.kind === "self" ? SELF_NAME : row.kind === "maintenance" ? MAINTENANCE_NAME : (sourceName ?? ""),
    sourceKind: row.kind === "backup" ? ((sourceKind as Run["sourceKind"]) ?? null) : null,
    trigger: row.trigger as Run["trigger"],
    status: row.status as RunStatus,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    snapshotId: row.snapshotId,
    stats: row.stats ?? null,
    warnings: row.warnings,
    error: row.error,
  };
}

export function runDetailView(row: RunRow, sourceName: string | null, sourceKind: string | null): RunDetail {
  return { ...runView(row, sourceName, sourceKind), log: row.log };
}

/** Runs with their source's name and kind. */
export function selectRuns(db: DbOrTx) {
  return db
    .select({ run: runs, sourceName: sources.name, sourceKind: sources.kind })
    .from(runs)
    .leftJoin(sources, eq(sources.id, runs.sourceId));
}

export async function createRun(
  db: DbOrTx,
  values: { kind: RunKind; sourceId: string | null; trigger: "schedule" | "manual" },
): Promise<RunRow> {
  const [row] = await db.insert(runs).values(values).returning();
  return row!;
}

/** The queued or running run of a source, if any. */
export async function activeRunOf(db: DbOrTx, sourceId: string) {
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.sourceId, sourceId), inArray(runs.status, ["queued", "running"])))
    .limit(1);
  return row ?? null;
}

/** Appends lines to a run's log (time-stamped), keeping it at most LOG_LIMIT lines. */
export async function appendLog(db: DbOrTx, runId: string, ...lines: string[]) {
  if (lines.length === 0) return;
  const time = new Date().toISOString().slice(11, 19);
  const stamped = lines.map((line) => `${time} ${line}`.slice(0, 1000));
  // Only the process that runs a run writes its log, so reading and writing it back is safe.
  const [row] = await db.select({ log: runs.log }).from(runs).where(eq(runs.id, runId));
  if (!row) return;
  let log = [...row.log, ...stamped];
  if (log.length > LOG_LIMIT) {
    const head = log.slice(0, 50).filter((line) => !line.includes("lines left out"));
    log = [...head, `… lines left out`, ...log.slice(-(LOG_LIMIT - head.length - 1))];
  }
  await db.update(runs).set({ log }).where(eq(runs.id, runId));
}

export type RunOutcome =
  | { status: "succeeded" | "warning"; snapshotId: string | null; stats: RunStats | null; warnings: string[] }
  | { status: "failed" | "cancelled"; error: string; warnings?: string[] };

/**
 * Ends a run, once: a run that ended already (cancelled, timed out) stays
 * as it is. A successful backup also updates its source's last success
 * and snapshot. Returns false when the run had ended already.
 */
export async function finishRun(db: DbOrTx, runId: string, outcome: RunOutcome): Promise<boolean> {
  const succeeded = outcome.status === "succeeded" || outcome.status === "warning";
  const [row] = await db
    .update(runs)
    .set({
      status: outcome.status,
      finishedAt: sql`now()`,
      snapshotId: succeeded ? outcome.snapshotId : null,
      stats: succeeded ? outcome.stats : null,
      warnings: outcome.warnings?.slice(0, 50) ?? [],
      error:
        outcome.status === "failed" || outcome.status === "cancelled" ? outcome.error.slice(0, 1000) : null,
    })
    .where(and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])))
    .returning();
  if (!row) return false;
  if (succeeded && row.kind === "backup" && row.sourceId && outcome.snapshotId) {
    await db
      .update(sources)
      .set({
        lastSuccessAt: row.finishedAt ?? new Date(),
        lastSnapshot: {
          id: outcome.snapshotId.slice(0, 8),
          time: (row.finishedAt ?? new Date()).toISOString(),
          bytes: outcome.stats?.bytesProcessed ?? null,
          files: outcome.stats?.filesProcessed ?? null,
        },
      })
      .where(eq(sources.id, row.sourceId));
  }
  return true;
}

/**
 * Ends runs that a restart interrupted: they count as running, but no
 * process runs them any more (`where` picks them among the running runs).
 * A scheduled run goes back into the queue, once: its trigger becomes
 * `retry`, so a retry that a restart interrupts too fails. A deploy thus
 * never costs a day's backup, and restic's deduplication keeps the second
 * try cheap. A run an admin asked to cancel ends as cancelled; any other
 * fails with `error`. Returns the runs queued again.
 */
export async function endInterruptedRuns(db: DbOrTx, where: SQL, error: string): Promise<string[]> {
  const running = and(eq(runs.status, "running"), where);
  // One transaction: a run queued again becomes claimable only once the others are ended, so
  // an agent cannot claim it in between and see it failed by the last update.
  const requeued = await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ status: "cancelled", finishedAt: sql`now()`, error: "Cancelled by an admin" })
      .where(and(running, eq(runs.cancelRequested, true)));
    const queued = await tx
      .update(runs)
      .set({ status: "queued", trigger: "retry", queuedAt: sql`now()`, startedAt: null, upload: null })
      .where(and(running, eq(runs.trigger, "schedule")))
      .returning({ id: runs.id });
    await tx
      .update(runs)
      .set({ status: "failed", finishedAt: sql`now()`, error: error.slice(0, 1000) })
      .where(running);
    return queued;
  });
  for (const run of requeued) await appendLog(db, run.id, `${error}; queued again`);
  return requeued.map((run) => run.id);
}

/** An admin stops a run: a queued one ends at once, a running one at the next check of its process. */
export async function requestCancel(db: DbOrTx, runId: string) {
  await db
    .update(runs)
    .set({ status: "cancelled", finishedAt: sql`now()`, error: "Cancelled by an admin" })
    .where(and(eq(runs.id, runId), eq(runs.status, "queued")));
  await db
    .update(runs)
    .set({ cancelRequested: true })
    .where(and(eq(runs.id, runId), eq(runs.status, "running")));
}

export async function isCancelRequested(db: DbOrTx, runId: string): Promise<boolean> {
  const [row] = await db.select({ cancel: runs.cancelRequested }).from(runs).where(eq(runs.id, runId));
  return row?.cancel ?? true;
}

/**
 * Serializes the claims of runs (the worker's and the agents'), so that an
 * upkeep and a backup never both start: each claim checks what runs and
 * claims inside one transaction holding this lock.
 */
export async function lockClaims(tx: DbOrTx) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('backups.claims'))`);
}

/** Whether any run of these kinds is running (upkeep waits for backups, agents wait for upkeep). */
export async function anyRunning(db: DbOrTx, kinds: RunKind[]): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, "running"), inArray(runs.kind, kinds)))
    .limit(1);
  return Boolean(row);
}

/** The newest run of a kind (upkeep, this app's own backup); with `finished`, the newest that ended. */
export async function latestRun(
  db: DbOrTx,
  kind: RunKind,
  options: { finished?: boolean } = {},
): Promise<Run | null> {
  const where = options.finished
    ? and(eq(runs.kind, kind), inArray(runs.status, ["succeeded", "warning", "failed"]))
    : eq(runs.kind, kind);
  const [row] = await selectRuns(db).where(where).orderBy(desc(runs.queuedAt)).limit(1);
  return row ? runView(row.run, row.sourceName, row.sourceKind) : null;
}

/** Deletes finished runs older than RUN_HISTORY_DAYS; the newest run of each source always stays. */
export async function pruneRunHistory(db: DbOrTx) {
  const days = config().RUN_HISTORY_DAYS;
  if (days <= 0) return;
  await db
    .delete(runs)
    .where(
      and(
        inArray(runs.status, ["succeeded", "warning", "failed", "cancelled"]),
        lt(runs.queuedAt, sql`now() - make_interval(days => ${days})`),
        sql`${runs.id} not in (select distinct on (source_id, kind) id from runs order by source_id, kind, queued_at desc)`,
      ),
    );
}
