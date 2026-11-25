import { z } from "zod";
import { idSchema, secretInput } from "./common";
import { runSchema } from "./runs";
import { retentionSchema, scheduleSchema } from "./schedule";
import {
  s3AccessKeyIdSchema,
  s3BucketSchema,
  s3EndpointSchema,
  s3PrefixSchema,
  s3RegionSchema,
} from "./target";

/*
 * Sources: what is backed up.
 *   app           an app with PostgreSQL and Docker volumes, through the backup agent
 *                 (database dump and volumes, one tar per snapshot)
 *   google_drive  a shared drive or folders of Google Workspace, through a
 *                 service account with domain-wide delegation (rclone)
 *   personio      people with their attributes, and their documents
 *   s3_bucket     the objects of an S3-compatible bucket (or of a folder
 *                 in it), through a read-only key (rclone)
 * Secrets (keys, client secrets) are write-only: the API answers with hints.
 */

export const SOURCE_KINDS = ["app", "google_drive", "personio", "s3_bucket"] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKindSchema>;

const name = z.string().trim().min(1, "Enter a name").max(100);

/* ---------- App (backup-agent) ---------- */

export const appConfigSchema = z.object({});
export type AppConfig = z.infer<typeof appConfigSchema>;

/** What the agent reported at its last poll. */
export const agentInfoSchema = z.object({
  lastSeenAt: z.string().nullable(),
  version: z.string().nullable(),
  appName: z.string().nullable(),
  appImage: z.string().nullable(),
  database: z.boolean().nullable(),
  volumes: z.array(z.string()),
  /** Names of the app's settings that a restore needs from its .env (the backups hold no values). */
  secrets: z.array(z.string()),
  /** The last characters of the token, to tell tokens apart. */
  tokenHint: z.string().nullable(),
});
export type AgentInfo = z.infer<typeof agentInfoSchema>;

/* ---------- Google Drive ---------- */

export const driveFolderSchema = z.object({
  /** The folder's ID: the last part of its address (drive.google.com/drive/folders/<id>). */
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{10,100}$/, "Paste the folder ID from its address"),
  /** The folder's name in the backup. */
  label: z.string().trim().min(1, "Enter a name").max(100),
});
export type DriveFolder = z.infer<typeof driveFolderSchema>;

export const driveScopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("shared_drive"),
    /** The shared drive's ID (drive.google.com/drive/folders/<id> when the drive is open). */
    driveId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{10,100}$/, "Paste the shared drive's ID from its address"),
  }),
  z.object({
    type: z.literal("folders"),
    folders: z.array(driveFolderSchema).min(1, "Add at least one folder").max(50),
  }),
]);
export type DriveScope = z.infer<typeof driveScopeSchema>;

export const driveConfigSchema = z.object({
  /** The Workspace user the service account acts as; must see the drive or folders. */
  subject: z.email("Enter the email address of a Workspace user"),
  scope: driveScopeSchema,
});
export type DriveConfig = z.infer<typeof driveConfigSchema>;

export const driveSecretsInputSchema = z.object({
  /** The service account's JSON key. */
  serviceAccountKey: secretInput(20_000),
});

export const driveConfigViewSchema = driveConfigSchema.extend({
  /** client_email of the stored key; null without a key. */
  serviceAccountEmail: z.string().nullable(),
  /** client_id of the stored key, for domain-wide delegation in the Admin console. */
  serviceAccountClientId: z.string().nullable(),
});

/* ---------- Personio ---------- */

export const personioConfigSchema = z.object({
  /** API base URL; https://api.personio.de unless Personio says otherwise. */
  baseUrl: z.url({ protocol: /^https$/, message: "Enter an https URL" }).default("https://api.personio.de"),
  clientId: z.string().trim().min(1, "Enter the client ID").max(200),
  /** Also export each person's documents (Personio's document API, in beta). */
  documents: z.boolean().default(true),
});
export type PersonioConfig = z.infer<typeof personioConfigSchema>;

export const personioSecretsInputSchema = z.object({ clientSecret: secretInput(500) });

export const personioConfigViewSchema = personioConfigSchema.extend({
  clientSecretHint: z.string().nullable(),
});

/* ---------- S3 bucket ---------- */

export const s3BucketConfigSchema = z.object({
  endpoint: s3EndpointSchema,
  region: s3RegionSchema,
  bucket: s3BucketSchema,
  /** Only this folder of the bucket; empty: the whole bucket. */
  prefix: s3PrefixSchema,
  accessKeyId: s3AccessKeyIdSchema,
});
export type S3BucketConfig = z.infer<typeof s3BucketConfigSchema>;

export const s3BucketSecretsInputSchema = z.object({ secretAccessKey: secretInput(500) });

export const s3BucketConfigViewSchema = s3BucketConfigSchema.extend({
  secretAccessKeyHint: z.string().nullable(),
});

/* ---------- Sources ---------- */

/**
 * ok; warning: the last backup skipped something; failed: the last backup
 * failed; overdue: no successful backup for 1.5 intervals; running; queued:
 * planned (app sources: waiting for the agent); never: no backup yet;
 * paused: switched off.
 */
export const sourceStatusSchema = z.enum([
  "ok",
  "warning",
  "failed",
  "overdue",
  "running",
  "queued",
  "never",
  "paused",
]);
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

export const snapshotSummarySchema = z.object({
  id: z.string(),
  time: z.string(),
  /** Bytes the snapshot holds (before deduplication). */
  bytes: z.number().nullable(),
  files: z.number().nullable(),
});
export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

const sourceBase = {
  id: idSchema,
  name: z.string(),
  enabled: z.boolean(),
  schedule: scheduleSchema,
  retention: retentionSchema,
  status: sourceStatusSchema,
  lastRun: runSchema.nullable(),
  lastSuccessAt: z.string().nullable(),
  /** The last successful run's snapshot. */
  lastSnapshot: snapshotSummarySchema.nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
};

export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ ...sourceBase, kind: z.literal("app"), config: appConfigSchema, agent: agentInfoSchema }),
  z.object({
    ...sourceBase,
    kind: z.literal("google_drive"),
    config: driveConfigViewSchema,
    agent: z.null(),
  }),
  z.object({ ...sourceBase, kind: z.literal("personio"), config: personioConfigViewSchema, agent: z.null() }),
  z.object({
    ...sourceBase,
    kind: z.literal("s3_bucket"),
    config: s3BucketConfigViewSchema,
    agent: z.null(),
  }),
]);
export type Source = z.infer<typeof sourceSchema>;

export const sourceListSchema = z.object({ items: z.array(sourceSchema) });
export type SourceList = z.infer<typeof sourceListSchema>;

const inputBase = {
  name,
  enabled: z.boolean().default(true),
  schedule: scheduleSchema,
  retention: retentionSchema,
};

/** Create (POST /sources) and change (PUT /sources/:id; the kind cannot change). */
export const sourceInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...inputBase, kind: z.literal("app"), config: appConfigSchema.default({}) }),
  z.object({
    ...inputBase,
    kind: z.literal("google_drive"),
    config: driveConfigSchema,
    secrets: driveSecretsInputSchema.default({}),
  }),
  z.object({
    ...inputBase,
    kind: z.literal("personio"),
    config: personioConfigSchema,
    secrets: personioSecretsInputSchema.default({}),
  }),
  z.object({
    ...inputBase,
    kind: z.literal("s3_bucket"),
    config: s3BucketConfigSchema,
    secrets: s3BucketSecretsInputSchema.default({}),
  }),
]);
export type SourceInput = z.input<typeof sourceInputSchema>;
export type ParsedSourceInput = z.output<typeof sourceInputSchema>;

/** POST /sources answers with the source and, for an app source, its agent token (shown once). */
export const sourceCreatedSchema = z.object({ source: sourceSchema, token: z.string().nullable() });
export type SourceCreated = z.infer<typeof sourceCreatedSchema>;

/** POST /sources/:id/token: a new agent token; the old one stops working. */
export const agentTokenSchema = z.object({ token: z.string() });
export type AgentToken = z.infer<typeof agentTokenSchema>;

/** POST /sources/:id/test: can the app reach the source, and how much is there? */
export const sourceTestSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Items found (files, objects, people), when counted. */
  items: z.number().nullable(),
  /** Their size in bytes, when known. */
  bytes: z.number().nullable(),
  /** Free space for the local copy (Google Drive, S3 bucket), in bytes. */
  freeBytes: z.number().nullable(),
});
export type SourceTest = z.infer<typeof sourceTestSchema>;

/** DELETE /sources/:id?snapshots=keep|forget */
export const sourceDeleteQuerySchema = z.object({
  snapshots: z.enum(["keep", "forget"]).default("keep"),
});

export const snapshotListSchema = z.object({ items: z.array(snapshotSummarySchema) });
export type SnapshotList = z.infer<typeof snapshotListSchema>;

/** A restic snapshot ID: 8 (short) or 64 hex characters. */
export const SNAPSHOT_ID = /^([0-9a-f]{8}|[0-9a-f]{64})$/;

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  app: "App (backup agent)",
  google_drive: "Google Drive",
  personio: "Personio",
  s3_bucket: "S3 bucket",
};
