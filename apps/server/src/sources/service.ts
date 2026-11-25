import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AGENT_TOKEN_PREFIX } from "@backup/shared/api/agent";
import type {
  DriveConfig,
  ParsedSourceInput,
  PersonioConfig,
  S3BucketConfig,
  Source,
  SourceKind,
} from "@backup/shared/api/sources";
import type { RunStatus } from "@backup/shared/api/runs";
import { config } from "../config";
import type { DbOrTx } from "../db/client";
import { runs, sources } from "../db/schema";
import { decryptSecret, encryptSecret, randomSecret, secretHint, sha256Hex } from "../core/crypto";
import { audit } from "../core/audit";
import { notFound, validationError } from "../http/errors";
import type { Actor } from "../auth/principal";
import { runView } from "../runs/service";
import { nextRunAfter, sourceStatus } from "./schedule";

export type SourceRow = typeof sources.$inferSelect;

/** A service account key as Google issues it (JSON). */
export type ServiceAccountKey = {
  type: "service_account";
  client_email: string;
  client_id: string;
  private_key: string;
  token_uri?: string;
};

/** Reads a pasted service account key; null when it is not one. */
export function parseServiceAccountKey(text: string): ServiceAccountKey | null {
  try {
    const key = JSON.parse(text) as Partial<ServiceAccountKey>;
    if (
      key.type === "service_account" &&
      typeof key.client_email === "string" &&
      typeof key.private_key === "string" &&
      key.private_key.includes("PRIVATE KEY")
    ) {
      return { ...key, client_id: String(key.client_id ?? "") } as ServiceAccountKey;
    }
  } catch {
    // Not JSON.
  }
  return null;
}

/** A new agent token: shown once, stored as its SHA-256. */
export function newAgentToken() {
  const token = `${AGENT_TOKEN_PREFIX}${randomSecret(32)}`;
  return { token, hash: sha256Hex(token), hint: secretHint(token) };
}

function decryptOrNull(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

/** The newest run and the newest finished run of each source. */
async function runsBySource(db: DbOrTx, ids: string[]) {
  if (ids.length === 0) return { newest: new Map(), finished: new Map() };
  const newest = await db
    .selectDistinctOn([runs.sourceId])
    .from(runs)
    .where(and(inArray(runs.sourceId, ids), eq(runs.kind, "backup")))
    .orderBy(runs.sourceId, desc(runs.queuedAt));
  const finished = await db
    .selectDistinctOn([runs.sourceId], { sourceId: runs.sourceId, status: runs.status })
    .from(runs)
    .where(
      and(
        inArray(runs.sourceId, ids),
        eq(runs.kind, "backup"),
        inArray(runs.status, ["succeeded", "warning", "failed"]),
      ),
    )
    .orderBy(runs.sourceId, desc(runs.queuedAt));
  return {
    newest: new Map(newest.map((row) => [row.sourceId!, row])),
    finished: new Map(finished.map((row) => [row.sourceId!, { status: row.status as RunStatus }])),
  };
}

export async function sourceViews(db: DbOrTx, rows: SourceRow[], now = new Date()): Promise<Source[]> {
  const { newest, finished } = await runsBySource(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const latest = newest.get(row.id) ?? null;
    const active = latest && ["queued", "running"].includes(latest.status) ? latest : null;
    const base = {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      schedule: row.schedule,
      retention: row.retention,
      status: sourceStatus({
        enabled: row.enabled,
        schedule: row.schedule,
        createdAt: row.createdAt,
        lastSuccessAt: row.lastSuccessAt,
        active: active ? { status: active.status as RunStatus } : null,
        lastFinished: finished.get(row.id) ?? null,
        now,
      }),
      lastRun: latest ? runView(latest, row.name, row.kind) : null,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastSnapshot: row.lastSnapshot ?? null,
      nextRunAt: row.enabled ? (row.nextRunAt?.toISOString() ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    };
    if (row.kind === "google_drive") {
      const key = parseServiceAccountKey(decryptOrNull(row.secrets.serviceAccountKey) ?? "");
      return {
        ...base,
        kind: "google_drive",
        config: {
          ...(row.config as DriveConfig),
          serviceAccountEmail: key?.client_email ?? null,
          serviceAccountClientId: key?.client_id || null,
        },
        agent: null,
      };
    }
    if (row.kind === "personio") {
      const secret = decryptOrNull(row.secrets.clientSecret);
      return {
        ...base,
        kind: "personio",
        config: { ...(row.config as PersonioConfig), clientSecretHint: secret ? secretHint(secret) : null },
        agent: null,
      };
    }
    if (row.kind === "s3_bucket") {
      const secret = decryptOrNull(row.secrets.secretAccessKey);
      return {
        ...base,
        kind: "s3_bucket",
        config: {
          ...(row.config as S3BucketConfig),
          secretAccessKeyHint: secret ? secretHint(secret) : null,
        },
        agent: null,
      };
    }
    return {
      ...base,
      kind: "app",
      config: {},
      agent: {
        lastSeenAt: row.agentLastSeenAt?.toISOString() ?? null,
        version: row.agentInfo?.version ?? null,
        appName: row.agentInfo?.appName || null,
        appImage: row.agentInfo?.appImage || null,
        database: row.agentInfo?.database ?? null,
        volumes: row.agentInfo?.volumes ?? [],
        secrets: row.agentInfo?.secrets ?? [],
        tokenHint: row.agentTokenHint,
      },
    };
  });
}

export async function listSourceRows(db: DbOrTx) {
  return db.select().from(sources).orderBy(sources.name);
}

export async function getSourceRow(db: DbOrTx, id: string): Promise<SourceRow> {
  const [row] = await db.select().from(sources).where(eq(sources.id, id));
  if (!row) throw notFound("No such source");
  return row;
}

export async function sourceView(db: DbOrTx, id: string): Promise<Source> {
  return (await sourceViews(db, [await getSourceRow(db, id)]))[0]!;
}

/** The encrypted secrets of an input, merged into the stored ones; checks what each kind needs. */
function secretsOf(input: ParsedSourceInput, stored: Record<string, string>): Record<string, string> {
  if (input.kind === "google_drive") {
    const pasted = input.secrets.serviceAccountKey;
    if (pasted) {
      if (!parseServiceAccountKey(pasted)) {
        throw validationError({
          "secrets.serviceAccountKey":
            "Paste the service account's JSON key (it has type service_account and a private key)",
        });
      }
      return { serviceAccountKey: encryptSecret(pasted.trim()) };
    }
    if (!stored.serviceAccountKey) {
      throw validationError({ "secrets.serviceAccountKey": "Paste the service account's JSON key" });
    }
    return { serviceAccountKey: stored.serviceAccountKey };
  }
  if (input.kind === "personio") {
    const secret = input.secrets.clientSecret;
    if (secret) return { clientSecret: encryptSecret(secret.trim()) };
    if (!stored.clientSecret) throw validationError({ "secrets.clientSecret": "Enter the client secret" });
    return { clientSecret: stored.clientSecret };
  }
  if (input.kind === "s3_bucket") {
    const secret = input.secrets.secretAccessKey;
    if (secret) return { secretAccessKey: encryptSecret(secret.trim()) };
    if (!stored.secretAccessKey) {
      throw validationError({ "secrets.secretAccessKey": "Enter the secret key" });
    }
    return { secretAccessKey: stored.secretAccessKey };
  }
  return {};
}

function configOf(input: ParsedSourceInput): Record<string, unknown> {
  if (input.kind === "google_drive") return input.config;
  if (input.kind === "personio")
    return { ...input.config, baseUrl: input.config.baseUrl.replace(/\/+$/, "") };
  if (input.kind === "s3_bucket")
    return { ...input.config, endpoint: input.config.endpoint.replace(/\/+$/, "") };
  return {};
}

export async function createSource(db: DbOrTx, input: ParsedSourceInput, actor: Actor) {
  const token = input.kind === "app" ? newAgentToken() : null;
  const [row] = await db
    .insert(sources)
    .values({
      kind: input.kind,
      name: input.name,
      enabled: input.enabled,
      schedule: input.schedule,
      retention: input.retention,
      config: configOf(input),
      secrets: secretsOf(input, {}),
      agentTokenHash: token?.hash ?? null,
      agentTokenHint: token?.hint ?? null,
      nextRunAt: nextRunAfter(input.schedule, new Date(), config().TZ),
    })
    .returning();
  await audit(db, actor, {
    action: "source.create",
    entityType: "source",
    entityId: row!.id,
    summary: `Added the source ${input.name}`,
  });
  return { row: row!, token: token?.token ?? null };
}

export async function updateSource(db: DbOrTx, id: string, input: ParsedSourceInput, actor: Actor) {
  const current = await getSourceRow(db, id);
  if (current.kind !== input.kind) throw validationError({ kind: "The kind of a source cannot change" });
  const scheduleChanged = JSON.stringify(current.schedule) !== JSON.stringify(input.schedule);
  await db
    .update(sources)
    .set({
      name: input.name,
      enabled: input.enabled,
      schedule: input.schedule,
      retention: input.retention,
      config: configOf(input),
      secrets: secretsOf(input, current.secrets),
      ...(scheduleChanged || (!current.enabled && input.enabled)
        ? { nextRunAt: nextRunAfter(input.schedule, new Date(), config().TZ) }
        : {}),
      // A changed setup starts a new history of problems.
      ...(input.enabled ? {} : { alertState: null }),
      updatedAt: sql`now()`,
    })
    .where(eq(sources.id, id));
  const what =
    current.enabled !== input.enabled
      ? input.enabled
        ? `Resumed the source ${input.name}`
        : `Paused the source ${input.name}`
      : `Changed the source ${input.name}`;
  await audit(db, actor, { action: "source.update", entityType: "source", entityId: id, summary: what });
}

export async function rotateAgentToken(db: DbOrTx, id: string, actor: Actor): Promise<string> {
  const current = await getSourceRow(db, id);
  if (current.kind !== "app") throw validationError({ kind: "Only app sources have an agent token" });
  const token = newAgentToken();
  await db
    .update(sources)
    .set({ agentTokenHash: token.hash, agentTokenHint: token.hint, updatedAt: sql`now()` })
    .where(eq(sources.id, id));
  await audit(db, actor, {
    action: "source.token",
    entityType: "source",
    entityId: id,
    summary: `Issued a new agent token for ${current.name}`,
  });
  return token.token;
}

/** The source an agent token belongs to. */
export async function sourceByAgentToken(db: DbOrTx, token: string): Promise<SourceRow | null> {
  const [row] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.agentTokenHash, sha256Hex(token)), eq(sources.kind, "app")));
  return row ?? null;
}

/** The decrypted secret of a source; throws a readable error when it cannot be read. */
export function sourceSecret(row: SourceRow, name: string): string {
  const stored = row.secrets[name];
  if (!stored) throw new Error(`The source has no ${name}; edit it and enter it again`);
  return decryptSecret(stored);
}

export const kindOf = (row: SourceRow) => row.kind as SourceKind;
