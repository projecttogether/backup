import { Readable } from "node:stream";
import { Hono } from "hono";
import {
  SNAPSHOT_ID,
  sourceDeleteQuerySchema,
  sourceInputSchema,
  type SnapshotList,
  type SourceCreated,
  type SourceList,
} from "@backup/shared/api/sources";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { notFound } from "../http/errors";
import { idParam, jsonBody, queryOf, requireAdmin } from "../http/middleware";
import { audit } from "../core/audit";
import { logger } from "../logger";
import { runView } from "../runs/service";
import { dumpSnapshot, listSnapshots, sourceTag, type SnapshotInfo } from "../restic/restic";
import { openRepository } from "../target/target";
import { STREAM_FILENAME } from "../sources/agent";
import { stagingDir } from "../sources/google-drive";
import { deleteSource, startBackup, testSource } from "../sources/manage";
import {
  createSource,
  getSourceRow,
  listSourceRows,
  rotateAgentToken,
  sourceView,
  sourceViews,
  updateSource,
} from "../sources/service";

const router = new Hono<AppEnv>();

router.get("/sources", async (c) => {
  requireAdmin(c);
  const db = getDb();
  const body: SourceList = { items: await sourceViews(db, await listSourceRows(db)) };
  return c.json(body);
});

router.post("/sources", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, sourceInputSchema);
  const db = getDb();
  const { row, token } = await createSource(db, input, actor);
  const body: SourceCreated = { source: await sourceView(db, row.id), token };
  return c.json(body, 201);
});

router.get("/sources/:id", async (c) => {
  requireAdmin(c);
  return c.json(await sourceView(getDb(), idParam(c)));
});

router.put("/sources/:id", async (c) => {
  const actor = requireAdmin(c);
  const id = idParam(c);
  const input = await jsonBody(c, sourceInputSchema);
  const db = getDb();
  await updateSource(db, id, input, actor);
  return c.json(await sourceView(db, id));
});

router.delete("/sources/:id", async (c) => {
  const actor = requireAdmin(c);
  const id = idParam(c);
  const { snapshots } = queryOf(c, sourceDeleteQuerySchema);
  await deleteSource(getDb(), id, snapshots, actor);
  return c.body(null, 204);
});

router.post("/sources/:id/run", async (c) => {
  const actor = requireAdmin(c);
  const { row, run } = await startBackup(getDb(), idParam(c), actor);
  return c.json(runView(run, row.name, row.kind), 202);
});

router.post("/sources/:id/test", async (c) => {
  requireAdmin(c);
  return c.json(await testSource(getDb(), idParam(c)));
});

router.post("/sources/:id/token", async (c) => {
  const actor = requireAdmin(c);
  return c.json({ token: await rotateAgentToken(getDb(), idParam(c), actor) });
});

router.get("/sources/:id/snapshots", async (c) => {
  requireAdmin(c);
  const db = getDb();
  const row = await getSourceRow(db, idParam(c));
  const repository = await openRepository(db);
  const list = await listSnapshots(repository, sourceTag(row.id));
  const body: SnapshotList = {
    items: list.map((item) => ({ id: item.shortId, time: item.time, bytes: item.bytes, files: item.files })),
  };
  return c.json(body);
});

function downloadName(name: string, time: string, extension: string) {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "backup";
  return `${base}-${time.slice(0, 19).replace(/[:T]/g, "-")}.${extension}`;
}

/**
 * A snapshot as a file: the agent's tar for app sources, a zip of the copy
 * for the other kinds. Streams as restic reads it.
 */
router.get("/sources/:id/snapshots/:snapshot/download", async (c) => {
  const actor = requireAdmin(c);
  const db = getDb();
  const row = await getSourceRow(db, idParam(c));
  const wanted = c.req.param("snapshot");
  if (!SNAPSHOT_ID.test(wanted)) throw notFound("No such snapshot");
  const repository = await openRepository(db);
  const snapshot: SnapshotInfo | undefined = (await listSnapshots(repository, sourceTag(row.id))).find(
    (item) => item.id === wanted || item.shortId === wanted,
  );
  if (!snapshot) throw notFound("No such snapshot");
  const app = row.kind === "app";
  const dump = dumpSnapshot(repository, {
    snapshotId: snapshot.id,
    path: app ? `/${STREAM_FILENAME}` : (snapshot.paths[0] ?? stagingDir(row.id)),
    archive: app ? undefined : "zip",
    signal: c.req.raw.signal,
  });
  await audit(db, actor, {
    action: "snapshot.download",
    entityType: "source",
    entityId: row.id,
    summary: `Downloaded snapshot ${snapshot.shortId} of ${row.name}`,
  });
  const filename = downloadName(row.name, snapshot.time, app ? "tar" : "zip");
  c.header("content-type", app ? "application/x-tar" : "application/zip");
  c.header("content-disposition", `attachment; filename="${filename}"`);
  c.header("cache-control", "no-store");
  // restic's output as it comes; when restic fails, the body breaks off with an
  // error, so the browser never sees a truncated file as a complete download.
  const body = (Readable.toWeb(dump.stream) as ReadableStream<Uint8Array>).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush(controller) {
        try {
          await dump.done;
        } catch (error) {
          logger.warn({ err: error, sourceId: row.id }, "snapshot download incomplete");
          controller.error(error);
        }
      },
    }),
  );
  return c.body(body);
});

export default router;
