import { z } from "zod";
import { secretInput } from "./common";

/*
 * Alerts: email over SMTP to the recipients when a backup fails or is
 * overdue (and when it is back to normal), and a heartbeat: the worker
 * calls the heartbeat URL every 15 minutes while everything is fine, so a
 * monitor (healthchecks.io, Uptime Kuma, …) raises the alarm when the
 * calls stop, also when this app itself is down.
 */

export const smtpSecuritySchema = z.enum(["tls", "starttls", "none"]);

const recipients = z
  .array(z.email("Enter email addresses"))
  .max(20)
  .transform((list) => [...new Set(list.map((item) => item.toLowerCase()))]);

export const notificationsInputSchema = z.object({
  email: z.object({
    enabled: z.boolean(),
    host: z.string().trim().max(200),
    port: z.number().int().min(1).max(65535),
    security: smtpSecuritySchema,
    username: z.string().trim().max(200),
    password: secretInput(500),
    from: z.union([z.literal(""), z.email("Enter the sender's address")]),
    recipients,
  }),
  /** A secret: left out, the saved one stays; blank or null turns the heartbeat off. */
  heartbeatUrl: z
    .union([z.literal(""), z.url({ protocol: /^https?$/, message: "Enter an http(s) URL" })])
    .nullish(),
  /** Also tell when a source is back to normal. */
  notifyRecovery: z.boolean(),
});
export type NotificationsInput = z.input<typeof notificationsInputSchema>;

export const notificationsSchema = z.object({
  email: z.object({
    enabled: z.boolean(),
    host: z.string(),
    port: z.number(),
    security: smtpSecuritySchema,
    username: z.string(),
    passwordHint: z.string().nullable(),
    from: z.string(),
    recipients: z.array(z.string()),
  }),
  /** The saved heartbeat URL's server; its path authorizes the pings. Null without one. */
  heartbeatUrlHint: z.string().nullable(),
  notifyRecovery: z.boolean(),
  /** The last heartbeat call and its outcome. */
  heartbeat: z.object({ at: z.string(), ok: z.boolean(), message: z.string().nullable() }).nullable(),
});
export type Notifications = z.infer<typeof notificationsSchema>;

export const DEFAULT_NOTIFICATIONS: Notifications = {
  email: {
    enabled: false,
    host: "",
    port: 587,
    security: "starttls",
    username: "",
    passwordHint: null,
    from: "",
    recipients: [],
  },
  heartbeatUrlHint: null,
  notifyRecovery: true,
  heartbeat: null,
};

export const testResultSchema = z.object({ ok: z.boolean(), message: z.string() });
export type TestResult = z.infer<typeof testResultSchema>;
