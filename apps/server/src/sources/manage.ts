import { rm } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { SourceTest } from "@backup/shared/api/sources";
import type { DbOrTx } from "../db/client";
import { runs, sources } from "../db/schema";
import { conflict } from "../http/errors";
import { audit } from "../core/audit";
import type { Actor } from "../auth/principal";
import { activeRunOf, createRun, lockClaims } from "../runs/service";
import { repositoryUrl, sourceTag } from "../restic/restic";
import { openRepository, readTarget } from "../target/target";
import { queueForget } from "../worker/maintenance";
import { stagingDir, testDrive } from "./google-drive";
import { testPersonio } from "./personio";
import { testS3Bucket } from "./s3-bucket";
import { getSourceRow } from "./service";

/*
 * What the source pages do besides saving: delete, test, back up now. The
 * routes (modules/sources.ts) and the operator command call these.
 */

/** Deletes a source and its queued runs; its snapshots stay, or the next upkeep forgets them. */
export async function deleteSource(db: DbOrTx, id: string, snapshots: "keep" | "forget", actor: Actor) {
  const row = await getSourceRow(db, id);
  // Under the claims' lock: no run of the source starts while it is deleted, and
  // with the source its queued runs go (cascade).
  await db.transaction(async (tx) => {
    await lockClaims(tx);
    const [running] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.sourceId, id), eq(runs.status, "running")))
      .limit(1);
    if (running) throw conflict("A backup of this source is running. Cancel it first.", "run_active");
    await tx.delete(sources).where(eq(sources.id, id));
    // The next upkeep forgets the snapshots (it may wait for the repository).
    if (snapshots === "forget") {
      const target = await readTarget(tx);
      if (target) await queueForget(tx, sourceTag(id), repositoryUrl(target));
    }
  });
  await rm(stagingDir(id), { recursive: true, force: true }).catch(() => undefined);
  await audit(db, actor, {
    action: "source.delete",
    entityType: "source",
    entityId: id,
    summary:
      snapshots === "forget"
        ? `Deleted the source ${row.name}; the next upkeep forgets its snapshots`
        : `Deleted the source ${row.name}; its snapshots stay in the repository`,
  });
  return row;
}

/** Queues a backup of the source now; answers the run that is already queued or running, if any. */
export async function startBackup(db: DbOrTx, id: string, actor: Actor) {
  const row = await getSourceRow(db, id);
  const active = await activeRunOf(db, id);
  if (active) return { row, run: active, started: false };
  await openRepository(db);
  const run = await createRun(db, { kind: "backup", sourceId: id, trigger: "manual" });
  await audit(db, actor, {
    action: "source.run",
    entityType: "source",
    entityId: id,
    summary: `Started a backup of ${row.name}`,
  });
  return { row, run, started: true };
}

/** Can the app reach the source, and how much is there? App sources: has the agent asked lately? */
export async function testSource(db: DbOrTx, id: string): Promise<SourceTest> {
  const row = await getSourceRow(db, id);
  if (row.kind === "google_drive") return testDrive(row);
  if (row.kind === "personio") return testPersonio(row);
  if (row.kind === "s3_bucket") return testS3Bucket(row);
  const seen = row.agentLastSeenAt;
  const fresh = seen && Date.now() - seen.getTime() < 10 * 60_000;
  return {
    ok: Boolean(fresh),
    message: !seen
      ? "The agent has not asked yet. Add the backup-agent service to the app's compose file with BACKUP_URL and BACKUP_TOKEN."
      : fresh
        ? `The agent asked ${Math.round((Date.now() - seen.getTime()) / 1000)} seconds ago.`
        : `The agent last asked at ${seen.toISOString()}. Is its service running?`,
    items: row.agentInfo ? row.agentInfo.volumes.length : null,
    bytes: null,
    freeBytes: null,
  };
}
