import { lt, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { auditLog } from "../db/schema";
import { isOperator, type Actor } from "../auth/principal";

/**
 * Records who changed or downloaded what: an admin in the web app, or the
 * operator command, which shows as the actor `operator` with its command
 * after the summary. `summary` is shown to admins; never put secrets in it.
 */
export async function audit(
  db: DbOrTx,
  actor: Actor | null,
  entry: { action: string; entityType: string; entityId?: string | null; summary: string },
) {
  const operator = isOperator(actor) ? actor : null;
  const user = actor && !isOperator(actor) ? actor : null;
  await db.insert(auditLog).values({
    actorId: user?.id ?? null,
    actorEmail: user?.email ?? (operator ? "operator" : null),
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    // The command stays whole, also after a long summary.
    summary: operator
      ? `${entry.summary.slice(0, 500 - operator.command.length - 3)} (${operator.command})`
      : entry.summary.slice(0, 500),
  });
}

/** Deletes entries older than `days` days (AUDIT_LOG_DAYS). */
export async function pruneAuditLog(db: DbOrTx, days: number) {
  if (days <= 0) return;
  await db.delete(auditLog).where(lt(auditLog.createdAt, sql`now() - make_interval(days => ${days})`));
}
