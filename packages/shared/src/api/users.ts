import { z } from "zod";
import { idSchema, pageQuerySchema } from "./common";

/**
 * The signed-in person. Only admins sign in: backups hold every source's
 * data, so the app has no other role (ADMIN_EMAILS, ADMIN_GROUPS).
 */
export const meSchema = z.object({
  id: idSchema,
  email: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  isAdmin: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

/** Public: what the sign-in page shows. */
export const authConfigSchema = z.object({
  appName: z.string(),
  providerName: z.string(),
});
export type AuthConfig = z.infer<typeof authConfigSchema>;

/** What runs: the version is the commit the image was built from; null for a build from source. */
export const aboutSchema = z.object({ version: z.string().nullable() });
export type About = z.infer<typeof aboutSchema>;

export const auditEntrySchema = z.object({
  id: idSchema,
  createdAt: z.string(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  /** Short description, e.g. 'Downloaded a snapshot of Wiki'. Never contains secrets. */
  summary: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;
export const auditListQuerySchema = pageQuerySchema;
export const auditListSchema = z.object({ items: z.array(auditEntrySchema), total: z.number().int() });
export type AuditList = z.infer<typeof auditListSchema>;
