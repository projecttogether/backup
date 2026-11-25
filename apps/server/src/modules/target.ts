import { Hono } from "hono";
import { maintenanceInputSchema, targetConnectSchema, targetInputSchema } from "@backup/shared/api/target";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { jsonBody, requireAdmin } from "../http/middleware";
import {
  confirmRecoveryKit,
  connectTarget,
  downloadRecoveryKit,
  initializeTarget,
  saveMaintenance,
  saveTarget,
  targetView,
  testTarget,
} from "../target/target";

const router = new Hono<AppEnv>();

router.get("/target", async (c) => {
  requireAdmin(c);
  return c.json(await targetView(getDb()));
});

router.put("/target", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, targetInputSchema);
  const db = getDb();
  await saveTarget(db, input, actor);
  return c.json(await targetView(db));
});

router.post("/target/test", async (c) => {
  requireAdmin(c);
  const db = getDb();
  await testTarget(db);
  return c.json(await targetView(db));
});

router.post("/target/initialize", async (c) => {
  const actor = requireAdmin(c);
  const db = getDb();
  await initializeTarget(db, actor);
  return c.json(await targetView(db));
});

router.post("/target/connect", async (c) => {
  const actor = requireAdmin(c);
  const { password } = await jsonBody(c, targetConnectSchema);
  const db = getDb();
  await connectTarget(db, password, actor);
  return c.json(await targetView(db));
});

/** The recovery kit as a text file. Every download is in the audit log. */
router.get("/target/recovery-kit", async (c) => {
  const actor = requireAdmin(c);
  const now = new Date();
  const text = await downloadRecoveryKit(getDb(), actor, now);
  c.header("content-type", "text/plain; charset=utf-8");
  c.header(
    "content-disposition",
    `attachment; filename="backup-recovery-kit-${now.toISOString().slice(0, 10)}.txt"`,
  );
  c.header("cache-control", "no-store");
  return c.body(text);
});

router.post("/target/recovery-kit/confirm", async (c) => {
  const actor = requireAdmin(c);
  const db = getDb();
  await confirmRecoveryKit(db, actor);
  return c.json(await targetView(db));
});

router.put("/target/maintenance", async (c) => {
  const actor = requireAdmin(c);
  const input = await jsonBody(c, maintenanceInputSchema);
  const db = getDb();
  await saveMaintenance(db, input, actor);
  return c.json(await targetView(db));
});

export default router;
