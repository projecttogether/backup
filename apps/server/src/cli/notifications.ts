import { notificationsInputSchema } from "@backup/shared/api/notifications";
import {
  NOTIFICATIONS_KEY,
  notificationsView,
  saveNotifications,
  sendTestEmail,
  testHeartbeat,
} from "../alerts/notify";
import { readSetting } from "../core/settings";
import { getDb } from "../db/client";
import { parseWith } from "../http/errors";
import { UsageError } from "./io";
import type { Setting } from "./settings";

const TEST_USAGE = "cli settings test notifications --email|--heartbeat";

/** `notifications`: alert emails and the heartbeat (Notifications page, PUT /api/v1/notifications). */
export const notifications: Setting = {
  name: "notifications",
  label: "alert emails over SMTP and the heartbeat URL (Notifications)",
  list: false,
  async rows() {
    const db = getDb();
    if (!(await readSetting(db, NOTIFICATIONS_KEY)))
      return [{ name: "notifications", state: "not set", hints: [] }];
    const { email, heartbeatUrlHint } = await notificationsView(db);
    const complete = Boolean(email.host && email.from && email.recipients.length > 0);
    const hints = [email.enabled ? "email on" : "email off"];
    if (email.host) hints.push(`server ${email.host}:${email.port}`);
    if (email.from) hints.push(`from ${email.from}`);
    hints.push(`${email.recipients.length} recipient${email.recipients.length === 1 ? "" : "s"}`);
    if (email.passwordHint) hints.push(`password ${email.passwordHint}`);
    hints.push(heartbeatUrlHint ? `heartbeat ${heartbeatUrlHint}` : "no heartbeat");
    return [{ name: "notifications", state: email.enabled && !complete ? "incomplete" : "set", hints }];
  },
  show: () => notificationsView(getDb()),
  async apply(actor, body) {
    const db = getDb();
    await saveNotifications(db, parseWith(notificationsInputSchema, JSON.parse(body)), actor);
    return { json: await notificationsView(db) };
  },
  testOptions: { options: { email: { type: "boolean" }, heartbeat: { type: "boolean" } }, usage: TEST_USAGE },
  async test(actor, _id, { email, heartbeat }) {
    if (Boolean(email) === Boolean(heartbeat)) {
      throw new UsageError("Choose one test: --email or --heartbeat.", TEST_USAGE);
    }
    const result = email ? await sendTestEmail(getDb(), actor) : await testHeartbeat(getDb());
    return { result, ok: result.ok, message: result.ok ? undefined : result.message };
  },
};
