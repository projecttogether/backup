import { Hono } from "hono";
import { desc } from "drizzle-orm";
import type { Attention, Dashboard } from "@backup/shared/api/dashboard";
import { getDb } from "../db/client";
import { runs } from "../db/schema";
import type { AppEnv } from "../http/env";
import { requireAdmin } from "../http/middleware";
import { notificationsView } from "../alerts/notify";
import { latestRun, runView, selectRuns } from "../runs/service";
import { listSourceRows, sourceViews } from "../sources/service";
import { targetView } from "../target/target";

const router = new Hono<AppEnv>();

router.get("/dashboard", async (c) => {
  requireAdmin(c);
  const db = getDb();
  const [sources, target, maintenance, selfBackup, recent, notifications] = await Promise.all([
    listSourceRows(db).then((rows) => sourceViews(db, rows)),
    targetView(db),
    latestRun(db, "maintenance"),
    latestRun(db, "self"),
    selectRuns(db).orderBy(desc(runs.queuedAt)).limit(10),
    notificationsView(db),
  ]);
  const attention: Attention[] = [];
  if (!target.configured) {
    attention.push({
      level: "error",
      message: "Set up where the backups go: the target.",
      link: "/settings/target",
    });
  } else if (!target.repository.hasPassword || target.repository.state === "missing") {
    attention.push({
      level: "error",
      message: "Create the repository in the target.",
      link: "/settings/target",
    });
  } else if (target.repository.state === "error" || target.repository.state === "wrong_password") {
    attention.push({
      level: "error",
      message: `The repository cannot be opened: ${target.repository.message ?? "check the target"}`,
      link: "/settings/target",
    });
  }
  if (target.repository.hasPassword && !target.recoveryKitConfirmedAt) {
    attention.push({
      level: "warning",
      message: "Store the recovery kit: without it, the backups cannot be restored when this app is lost.",
      link: "/settings/target",
    });
  }
  if (target.lastCheck && !target.lastCheck.ok) {
    attention.push({ level: "error", message: "The last integrity check failed.", link: "/settings/target" });
  }
  if (maintenance?.status === "failed") {
    attention.push({
      level: "error",
      message: `The upkeep failed: ${maintenance.error ?? ""}`,
      link: `/runs/${maintenance.id}`,
    });
  }
  if (target.protection?.objectLock && !target.protection.objectLock.enabled) {
    attention.push({
      level: "info",
      message: "The bucket has no Object Lock: someone with the keys could delete the backups.",
      link: "/settings/target",
    });
  }
  if (!notifications.email.enabled && !notifications.heartbeatUrlHint) {
    attention.push({
      level: "warning",
      message: "Nobody hears about failed backups: set up email alerts or a heartbeat.",
      link: "/settings/notifications",
    });
  }
  if (sources.length === 0) {
    attention.push({ level: "info", message: "Add the first source.", link: "/sources/new" });
  }
  const body: Dashboard = {
    sources,
    target,
    maintenance,
    selfBackup,
    recentRuns: recent.map((row) => runView(row.run, row.sourceName, row.sourceKind)),
    attention,
  };
  return c.json(body);
});

export default router;
