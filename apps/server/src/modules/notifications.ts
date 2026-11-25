import { Hono } from "hono";
import { notificationsInputSchema } from "@backup/shared/api/notifications";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { jsonBody, requireAdmin } from "../http/middleware";
import { notificationsView, saveNotifications, sendTestEmail, testHeartbeat } from "../alerts/notify";

const router = new Hono<AppEnv>();

router.get("/notifications", async (c) => {
  requireAdmin(c);
  return c.json(await notificationsView(getDb()));
});

router.put("/notifications", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, notificationsInputSchema);
  const db = getDb();
  await saveNotifications(db, input, actor);
  return c.json(await notificationsView(db));
});

router.post("/notifications/test-email", async (c) => {
  const actor = requireAdmin(c);
  return c.json(await sendTestEmail(getDb(), actor));
});

router.post("/notifications/test-heartbeat", async (c) => {
  requireAdmin(c);
  return c.json(await testHeartbeat(getDb()));
});

export default router;
