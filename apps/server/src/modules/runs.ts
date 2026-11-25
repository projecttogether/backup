import { Hono } from "hono";
import { and, count, desc, eq, type SQL } from "drizzle-orm";
import { runListQuerySchema, type RunList } from "@backup/shared/api/runs";
import { getDb } from "../db/client";
import { runs } from "../db/schema";
import type { AppEnv } from "../http/env";
import { notFound } from "../http/errors";
import { idParam, queryOf, requireAdmin } from "../http/middleware";
import { audit } from "../core/audit";
import { requestCancel, runDetailView, runView, selectRuns } from "../runs/service";
import { queueUpkeep } from "../worker/scheduler";
import { openRepository } from "../target/target";

const router = new Hono<AppEnv>();

router.get("/runs", async (c) => {
  requireAdmin(c);
  const query = queryOf(c, runListQuerySchema);
  const filters: SQL[] = [];
  if (query.sourceId) filters.push(eq(runs.sourceId, query.sourceId));
  if (query.kind) filters.push(eq(runs.kind, query.kind));
  const where = filters.length > 0 ? and(...filters) : undefined;
  const db = getDb();
  const rows = await selectRuns(db)
    .where(where)
    .orderBy(desc(runs.queuedAt))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await db.select({ value: count() }).from(runs).where(where);
  const body: RunList = {
    items: rows.map((row) => runView(row.run, row.sourceName, row.sourceKind)),
    total: total?.value ?? 0,
  };
  return c.json(body);
});

router.get("/runs/:id", async (c) => {
  requireAdmin(c);
  const [row] = await selectRuns(getDb()).where(eq(runs.id, idParam(c)));
  if (!row) throw notFound("No such run");
  return c.json(runDetailView(row.run, row.sourceName, row.sourceKind));
});

router.post("/runs/:id/cancel", async (c) => {
  const actor = requireAdmin(c);
  const id = idParam(c);
  const db = getDb();
  const [row] = await selectRuns(db).where(eq(runs.id, id));
  if (!row) throw notFound("No such run");
  await requestCancel(db, id);
  await audit(db, actor, {
    action: "run.cancel",
    entityType: "run",
    entityId: id,
    summary: `Cancelled a run of ${row.sourceName ?? row.run.kind}`,
  });
  const [after] = await selectRuns(db).where(eq(runs.id, id));
  return c.json(runView(after!.run, after!.sourceName, after!.sourceKind));
});

/** Runs this app's own backup and the upkeep now. */
router.post("/maintenance/run", async (c) => {
  const actor = requireAdmin(c);
  const db = getDb();
  await openRepository(db);
  const run = await queueUpkeep(db, "manual");
  await audit(db, actor, {
    action: "maintenance.run",
    entityType: "run",
    entityId: run.id,
    summary: "Started the upkeep",
  });
  const [row] = await selectRuns(db).where(eq(runs.id, run.id));
  return c.json(runView(row!.run, row!.sourceName, row!.sourceKind), 202);
});

export default router;
