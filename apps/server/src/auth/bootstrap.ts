import { and, eq, notInArray, sql } from "drizzle-orm";
import { config } from "../config";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { logger } from "../logger";

/**
 * People made admins by an address that is no longer in ADMIN_EMAILS lose
 * the role (and with it their sessions) when the app starts. Group admins
 * are checked at their next sign-in, at most SESSION_HOURS later.
 */
export async function revokeRemovedAdmins(db: Db) {
  const emails = config().adminEmails;
  const removed = await db
    .update(users)
    .set({ isAdmin: false, adminSource: null, updatedAt: sql`now()` })
    .where(
      and(eq(users.adminSource, "email"), emails.length > 0 ? notInArray(users.email, emails) : sql`true`),
    )
    .returning({ id: users.id });
  if (removed.length > 0) logger.info({ count: removed.length }, "admins no longer in ADMIN_EMAILS removed");
}

export function isEnvironmentAdmin(email: string): boolean {
  return config().adminEmails.includes(email.toLowerCase());
}

/** Startup warnings about sign-in settings. */
export function warnAboutSignIn() {
  const settings = config();
  if (settings.adminEmails.length === 0 && settings.adminGroups.length === 0) {
    logger.warn("nobody can sign in: set ADMIN_EMAILS or ADMIN_GROUPS");
  }
  if (!settings.OIDC_REQUIRE_EMAIL_VERIFIED) {
    logger.warn("OIDC_REQUIRE_EMAIL_VERIFIED is off: email addresses the provider has not verified sign in");
  }
}
