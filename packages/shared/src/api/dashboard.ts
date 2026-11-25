import { z } from "zod";
import { runSchema } from "./runs";
import { sourceSchema } from "./sources";
import { targetSchema } from "./target";

/**
 * Setup steps or problems the dashboard shows above the sources, most
 * important first. `link` is an app path, e.g. /settings/target.
 */
export const attentionSchema = z.object({
  level: z.enum(["error", "warning", "info"]),
  message: z.string(),
  link: z.string().nullable(),
});
export type Attention = z.infer<typeof attentionSchema>;

export const dashboardSchema = z.object({
  sources: z.array(sourceSchema),
  target: targetSchema,
  /** The newest upkeep run and the newest backup of this app's own database. */
  maintenance: runSchema.nullable(),
  selfBackup: runSchema.nullable(),
  recentRuns: z.array(runSchema),
  attention: z.array(attentionSchema),
});
export type Dashboard = z.infer<typeof dashboardSchema>;
