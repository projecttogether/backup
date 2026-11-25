import { Hono } from "hono";
import { count, desc } from "drizzle-orm";
import { auditListQuerySchema, type AuditList } from "@backup/shared/api/users";
import { getDb } from "../db/client";
import { auditLog } from "../db/schema";
import type { AppEnv } from "../http/env";
import { queryOf, requireAdmin } from "../http/middleware";

const router = new Hono<AppEnv>();

router.get("/audit", async (c) => {
  requireAdmin(c);
  const query = queryOf(c, auditListQuerySchema);
  const db = getDb();
  const rows = await db
    .select()
    .from(auditLog)
    .orderBy(desc(auditLog.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [total] = await db.select({ value: count() }).from(auditLog);
  const body: AuditList = {
    items: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actorEmail: row.actorEmail,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      summary: row.summary,
    })),
    total: total?.value ?? 0,
  };
  return c.json(body);
});

export default router;
