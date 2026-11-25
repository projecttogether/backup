import * as Sentry from "@sentry/node";
import nodemailer from "nodemailer";
import { eq, sql } from "drizzle-orm";
import {
  DEFAULT_NOTIFICATIONS,
  type Notifications,
  type NotificationsInput,
  type TestResult,
} from "@backup/shared/api/notifications";
import type { notificationsInputSchema } from "@backup/shared/api/notifications";
import type { z } from "zod";
import { config } from "../config";
import type { Db, DbOrTx } from "../db/client";
import { sources } from "../db/schema";
import { logger } from "../logger";
import { decryptSecret, encryptSecret, secretHint } from "../core/crypto";
import { readSetting, readSettingForUpdate, updateSetting, writeSetting } from "../core/settings";
import { audit } from "../core/audit";
import { isOperator, type Actor } from "../auth/principal";
import { latestRun } from "../runs/service";
import { listSourceRows, sourceProblems, sourceViews } from "../sources/service";
import { readTarget } from "../target/target";
import { smtpReply } from "./smtp-reply";

/*
 * Alerts: an email when a source's backup fails or is overdue (once per
 * problem) and, when wanted, when it is back to normal; the same for the
 * upkeep. The heartbeat URL is called every 15 minutes while all is well.
 */

export const NOTIFICATIONS_KEY = "notifications";
const HEARTBEAT_STATE_KEY = "heartbeat";
const SYSTEM_ALERT_KEY = "system_alert";
const HEARTBEAT_EVERY_MS = 15 * 60_000;

type StoredNotifications = {
  email: Omit<Notifications["email"], "passwordHint"> & { password: string | null };
  /** Encrypted, or as 0.1.4 stored it until `sealHeartbeatUrl` ran; "" without one. */
  heartbeatUrl: string;
  notifyRecovery: boolean;
};
type HeartbeatState = { at: string; ok: boolean; message: string | null };

function unsaved(): StoredNotifications {
  const { email, notifyRecovery } = DEFAULT_NOTIFICATIONS;
  const { passwordHint: _hint, ...emailRest } = email;
  return { email: { ...emailRest, password: null }, heartbeatUrl: "", notifyRecovery };
}

async function stored(db: DbOrTx): Promise<StoredNotifications> {
  return (await readSetting<StoredNotifications>(db, NOTIFICATIONS_KEY)) ?? unsaved();
}

/** The heartbeat URL of a stored one, or null when it was encrypted with another ENCRYPTION_KEY. */
function readHeartbeatUrl(saved: string): string | null {
  // As 0.1.4 stored it.
  if (/^https?:/i.test(saved)) return saved;
  try {
    return decryptSecret(saved);
  } catch {
    return null;
  }
}

/** Encrypts the heartbeat URL that 0.1.4 and earlier stored; the worker does it when it starts. */
export async function sealHeartbeatUrl(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const value = await readSettingForUpdate<StoredNotifications>(tx, NOTIFICATIONS_KEY);
    if (!value || !/^https?:/i.test(value.heartbeatUrl)) return;
    const heartbeatUrl = encryptSecret(value.heartbeatUrl);
    await writeSetting<StoredNotifications>(tx, NOTIFICATIONS_KEY, { ...value, heartbeatUrl });
    logger.info("heartbeat URL encrypted");
  });
}

export async function notificationsView(db: DbOrTx): Promise<Notifications> {
  const { heartbeatUrl, notifyRecovery, ...value } = await stored(db);
  const { password, ...email } = value.email;
  const url = heartbeatUrl ? URL.parse(readHeartbeatUrl(heartbeatUrl) ?? "") : null;
  let hint: string | null = null;
  if (password) {
    try {
      hint = secretHint(decryptSecret(password));
    } catch {
      hint = "…";
    }
  }
  return {
    email: { ...email, passwordHint: hint },
    heartbeatUrlHint: heartbeatUrl ? (url ? `${url.origin}/…` : "…") : null,
    notifyRecovery,
    heartbeat: await readSetting<HeartbeatState>(db, HEARTBEAT_STATE_KEY),
  };
}

export async function saveNotifications(
  db: DbOrTx,
  input: z.output<typeof notificationsInputSchema>,
  actor: Actor,
) {
  const { password, ...email } = input.email;
  // Locked: what a save keeps is what another save or the worker's start just wrote.
  await updateSetting<StoredNotifications>(db, NOTIFICATIONS_KEY, (value) => {
    const current = value ?? unsaved();
    return {
      heartbeatUrl:
        input.heartbeatUrl === undefined
          ? current.heartbeatUrl
          : input.heartbeatUrl
            ? encryptSecret(input.heartbeatUrl)
            : "",
      notifyRecovery: input.notifyRecovery,
      email: { ...email, password: password ? encryptSecret(password) : current.email.password },
    };
  });
  await audit(db, actor, {
    action: "notifications.update",
    entityType: "notifications",
    summary: "Changed the alerts",
  });
}

export type Mail = { subject: string; text: string };

/**
 * Sends a mail to every recipient; throws a readable error. False when email
 * is off (nothing was sent: an alert then waits until it is on).
 */
export async function sendMail(
  db: DbOrTx,
  mail: Mail,
  options: { evenWhenOff?: boolean } = {},
): Promise<boolean> {
  const settings = (await stored(db)).email;
  if (!settings.enabled && !options.evenWhenOff) return false;
  if (!settings.host || !settings.from || settings.recipients.length === 0) {
    throw new Error("Set the SMTP server, the sender and at least one recipient");
  }
  const login = {
    username: settings.username,
    password: settings.username && settings.password ? decryptSecret(settings.password) : "",
  };
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    auth: login.username ? { user: login.username, pass: login.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    await transport.sendMail({
      from: settings.from,
      to: settings.recipients,
      subject: `[${config().APP_NAME}] ${mail.subject}`,
      text: `${mail.text}\n\n${config().APP_URL}\n`,
    });
  } catch (error) {
    const code =
      (error as { code?: string; responseCode?: number }).responseCode ?? (error as { code?: string }).code;
    const reply = smtpReply(error, login);
    // With a reply, nothing is lost: the cause would only repeat it, as it came, in the log.
    throw new Error(
      `The mail server refused: ${reply ?? code ?? (error as Error).message}`.slice(0, 300),
      reply ? undefined : { cause: error },
    );
  } finally {
    transport.close();
  }
  return true;
}

/** The test button: a mail to the recipients with the saved settings, even while email is off. */
export async function sendTestEmail(db: DbOrTx, actor: Actor): Promise<TestResult> {
  const who = isOperator(actor) ? `The operator command (${actor.command})` : actor.email;
  try {
    await sendMail(
      db,
      {
        subject: "Test email",
        text: `${who} sent this test from the notification settings. Alerts about failed and overdue backups arrive the same way.`,
      },
      { evenWhenOff: true },
    );
    return { ok: true, message: "Sent. Check the recipients' inboxes." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Not sent" };
  }
}

/** Calls the heartbeat URL. */
export async function callHeartbeat(url: string): Promise<{ ok: boolean; message: string | null }> {
  try {
    // The URL's path is its secret: no trace span (Sentry) records it.
    const response = await Sentry.suppressTracing(() =>
      fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000), redirect: "follow" }),
    );
    await response.body?.cancel();
    return response.ok ? { ok: true, message: null } : { ok: false, message: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      message:
        (error as { name?: string }).name === "TimeoutError"
          ? "No answer within 15 seconds"
          : "Not reachable",
    };
  }
}

/** Calls the saved heartbeat URL and records the outcome. */
async function sendHeartbeat(db: DbOrTx, saved: string, now: Date) {
  const url = readHeartbeatUrl(saved);
  const result = url
    ? await callHeartbeat(url)
    : { ok: false, message: "The saved URL cannot be read with this ENCRYPTION_KEY: enter it again" };
  await writeSetting(db, HEARTBEAT_STATE_KEY, { at: now.toISOString(), ...result });
  return result;
}

const problemText = { failed: "failed", overdue: "is overdue" } as const;

/**
 * Compares each source's status with what the admins were last told and
 * sends what changed; calls the heartbeat while nothing is wrong.
 */
export async function checkAlerts(db: Db, now = new Date()) {
  const settings = await stored(db);
  const rows = await listSourceRows(db);
  const views = await sourceViews(db, rows, now);
  // Not the displayed status: a queued or running backup must not hide a problem.
  const problems = await sourceProblems(db, rows, now);
  let healthy = true;
  for (const view of views) {
    const row = rows.find((item) => item.id === view.id)!;
    const problem = problems.get(view.id) ?? null;
    if (problem) healthy = false;
    if (problem && row.alertState !== problem) {
      const detail =
        problem === "failed"
          ? (view.lastRun?.error ?? "See the run in the app.")
          : `The last successful backup: ${view.lastSuccessAt ?? "never"}.`;
      await notify(db, row.id, problem, {
        subject: `Backup ${problemText[problem]}: ${view.name}`,
        text: `The backup of ${view.name} ${problemText[problem]}.\n\n${detail}\n\nSource: ${config().APP_URL}/sources/${view.id}`,
      });
    } else if (!problem && row.alertState && ["ok", "warning"].includes(view.status)) {
      if (settings.notifyRecovery) {
        await notify(db, row.id, null, {
          subject: `Backup back to normal: ${view.name}`,
          text: `The backup of ${view.name} works again.\n\nSource: ${config().APP_URL}/sources/${view.id}`,
        });
      } else {
        await db.update(sources).set({ alertState: null }).where(eq(sources.id, row.id));
      }
    }
  }

  // The upkeep and this app's own backup: one alert per failed run.
  const systemAlert = (await readSetting<Record<string, string | null>>(db, SYSTEM_ALERT_KEY)) ?? {};
  for (const [kind, name] of [
    ["maintenance", "The daily upkeep of the backup repository"],
    ["self", "The backup of this app's own database"],
  ] as const) {
    // The newest finished run: a retry that is queued or running does not count yet.
    const run = await latestRun(db, kind, { finished: true });
    if (run?.status !== "failed") continue;
    healthy = false;
    if (systemAlert[kind] === run.id) continue;
    const sent = await sendSafely(db, {
      subject: `${name} failed`,
      text: `${name} failed:\n\n${run.error ?? ""}\n\nRun: ${config().APP_URL}/runs/${run.id}`,
    });
    if (sent) {
      systemAlert[kind] = run.id;
      await writeSetting(db, SYSTEM_ALERT_KEY, systemAlert);
    }
  }

  const target = await readTarget(db);
  if (!target?.password || target.repository.state !== "ready") healthy = false;
  if (healthy && settings.heartbeatUrl) {
    const last = await readSetting<HeartbeatState>(db, HEARTBEAT_STATE_KEY);
    if (!last || now.getTime() - new Date(last.at).getTime() >= HEARTBEAT_EVERY_MS - 30_000) {
      const result = await sendHeartbeat(db, settings.heartbeatUrl, now);
      if (!result.ok) logger.warn({ code: result.message }, "heartbeat call failed");
    }
  }
}

/** Sends an alert; false when it was not sent (it is tried again at the next check). */
async function sendSafely(db: Db, mail: Mail): Promise<boolean> {
  try {
    return await sendMail(db, mail);
  } catch (error) {
    logger.warn({ err: error }, "alert email not sent");
    return false;
  }
}

/** Sends a source's alert and records it as sent; nothing is recorded when sending failed. */
async function notify(db: Db, sourceId: string, state: "failed" | "overdue" | null, mail: Mail) {
  if (!(await sendSafely(db, mail))) return;
  await db
    .update(sources)
    .set({ alertState: state, alertedAt: sql`now()` })
    .where(eq(sources.id, sourceId));
}

export async function testHeartbeat(db: DbOrTx): Promise<TestResult> {
  const settings = await stored(db);
  if (!settings.heartbeatUrl) return { ok: false, message: "Set a heartbeat URL first" };
  const result = await sendHeartbeat(db, settings.heartbeatUrl, new Date());
  return { ok: result.ok, message: result.ok ? "The heartbeat URL answered" : (result.message ?? "Failed") };
}

export type { NotificationsInput };
