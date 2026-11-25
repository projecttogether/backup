import { z } from "zod";
import { idSchema, pageQuerySchema } from "./common";

/** The kinds of source (sources.ts has the same list; repeated here to keep the files independent). */
const runSourceKindSchema = z.enum(["app", "google_drive", "personio"]);

/**
 * A run: one backup of a source, the app's own database (`self`), or the
 * repository's upkeep (`maintenance`: retention, prune, integrity check).
 */
export const runKindSchema = z.enum(["backup", "self", "maintenance"]);
export type RunKind = z.infer<typeof runKindSchema>;

/**
 * queued: planned, waiting for the worker or (app sources) the agent;
 * running; succeeded; warning: a snapshot was saved but something was
 * skipped (unreadable files, documents that failed); failed: no snapshot;
 * cancelled by an admin.
 */
export const runStatusSchema = z.enum(["queued", "running", "succeeded", "warning", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const FINISHED_RUN_STATUSES: RunStatus[] = ["succeeded", "warning", "failed", "cancelled"];

/**
 * schedule; manual (an admin, "Back up now"); retry: a scheduled run that a
 * restart interrupted, queued again once.
 */
export const runTriggerSchema = z.enum(["schedule", "manual", "retry"]);

export const runStatsSchema = z.object({
  /** Bytes read from the source. */
  bytesProcessed: z.number().nullable(),
  /** New data the repository stored (after deduplication, before compression). */
  bytesAdded: z.number().nullable(),
  filesProcessed: z.number().nullable(),
  filesNew: z.number().nullable(),
  filesChanged: z.number().nullable(),
});
export type RunStats = z.infer<typeof runStatsSchema>;

export const runSchema = z.object({
  id: idSchema,
  kind: runKindSchema,
  sourceId: idSchema.nullable(),
  /** The source's name, "Backup" for `self`, "Repository upkeep" for `maintenance`. */
  sourceName: z.string(),
  /** The source's kind; null for `self` and `maintenance`. */
  sourceKind: runSourceKindSchema.nullable(),
  trigger: runTriggerSchema,
  status: runStatusSchema,
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  snapshotId: z.string().nullable(),
  stats: runStatsSchema.nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
});
export type Run = z.infer<typeof runSchema>;

/** A run with its log: steps, and errors of single files or documents. */
export const runDetailSchema = runSchema.extend({ log: z.array(z.string()) });
export type RunDetail = z.infer<typeof runDetailSchema>;

export const runListQuerySchema = pageQuerySchema.extend({
  sourceId: idSchema.optional(),
  kind: runKindSchema.optional(),
});
export const runListSchema = z.object({ items: z.array(runSchema), total: z.number().int() });
export type RunList = z.infer<typeof runListSchema>;
