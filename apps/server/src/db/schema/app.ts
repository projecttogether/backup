import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Retention, Schedule } from "@backup/shared/api/schedule";
import type { RunStats } from "@backup/shared/api/runs";
import { users } from "./auth";

/** What the agent of an app source reported at its last poll. */
export type StoredAgentInfo = {
  version: string;
  appName: string;
  appImage: string;
  database: boolean;
  volumes: string[];
  /** Names of the settings a restore needs from the app's .env; missing in rows from before it existed. */
  secrets?: string[];
};

/** A snapshot of a successful run, as the dashboard shows it. */
export type StoredSnapshot = { id: string; time: string; bytes: number | null; files: number | null };

/**
 * What is backed up. `config` holds the kind's settings (never secrets);
 * `secrets` holds encrypted values (core/crypto.ts) by name.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** app | google_drive | personio | s3_bucket */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    schedule: jsonb("schedule").$type<Schedule>().notNull(),
    retention: jsonb("retention").$type<Retention>().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    secrets: jsonb("secrets").$type<Record<string, string>>().notNull().default({}),
    /** SHA-256 (hex) of an app source's agent token. */
    agentTokenHash: text("agent_token_hash").unique(),
    agentTokenHint: text("agent_token_hint"),
    agentLastSeenAt: timestamp("agent_last_seen_at", { withTimezone: true }),
    agentInfo: jsonb("agent_info").$type<StoredAgentInfo>(),
    /** When the scheduler plans the next run; null until it has looked at the source. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastSnapshot: jsonb("last_snapshot").$type<StoredSnapshot>(),
    /** The problem the admins were last told about (failed, overdue), or null. */
    alertState: text("alert_state"),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_sources_next_run").on(table.nextRunAt)],
);

/** Progress of an agent's upload, for timeouts and the run page. */
export type AgentUploadState = { parts: number; bytes: number; lastActivityAt: string };

/**
 * Runs: backups of a source (`backup`), of this app's own database
 * (`self`), and the repository's upkeep (`maintenance`).
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "cascade" }),
    /** schedule | manual | retry (a scheduled run that a restart interrupted, queued again once) */
    trigger: text("trigger").notNull(),
    /** queued | running | succeeded | warning | failed | cancelled */
    status: text("status").notNull().default("queued"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    snapshotId: text("snapshot_id"),
    stats: jsonb("stats").$type<RunStats>(),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    error: text("error"),
    /** Steps and per-item errors; at most LOG_LIMIT lines (runs/service.ts). */
    log: jsonb("log").$type<string[]>().notNull().default([]),
    upload: jsonb("upload").$type<AgentUploadState>(),
    /** An admin asked to stop it; the process running it stops at the next check. */
    cancelRequested: boolean("cancel_requested").notNull().default(false),
  },
  (table) => [
    index("idx_runs_source_queued").on(table.sourceId, table.queuedAt),
    index("idx_runs_kind_queued").on(table.kind, table.queuedAt),
    index("idx_runs_active")
      .on(table.status)
      .where(sql`${table.status} in ('queued', 'running')`),
  ],
);

/** Settings made in the app (target, notifications, repository state), one JSON value per key. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Who changed or downloaded what. Never holds secrets. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
  },
  (table) => [index("idx_audit_created").on(table.createdAt)],
);
