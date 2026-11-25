import { secretPayload, initialSecret, type SecretValue } from "@/components/ui/secret-field";
import {
  DEFAULT_RETENTION,
  DEFAULT_SCHEDULE,
  type HOURLY_STEPS,
  type Retention,
  type Schedule,
} from "@backup/shared/api/schedule";
import type { DriveScope, Source, SourceInput, SourceKind } from "@backup/shared/api/sources";

/*
 * The source form's values (text fields stay strings) and the API input
 * they become. Pure, so the form and the Pause/Resume button share it.
 */

export type HourlyStep = (typeof HOURLY_STEPS)[number];
export type FolderRow = { key: number; id: string; label: string };

export type SourceFormValues = {
  name: string;
  enabled: boolean;
  scheduleType: Schedule["type"];
  every: HourlyStep;
  minute: string;
  /** HH:MM, for daily and weekly. */
  time: string;
  day: number;
  retention: Record<keyof Retention, string>;
  // Google Drive
  subject: string;
  scopeType: DriveScope["type"];
  driveId: string;
  folders: FolderRow[];
  serviceAccountKey: string;
  // Personio
  baseUrl: string;
  clientId: string;
  documents: boolean;
  clientSecret: SecretValue;
  // S3 bucket
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: SecretValue;
};

export const RETENTION_KEYS = ["daily", "weekly", "monthly", "yearly"] as const;
export const DEFAULT_PERSONIO_URL = "https://api.personio.de";

let folderKey = 0;
export function folderRow(id = "", label = ""): FolderRow {
  folderKey += 1;
  return { key: folderKey, id, label };
}

function retentionStrings(retention: Retention): Record<keyof Retention, string> {
  return {
    daily: String(retention.daily),
    weekly: String(retention.weekly),
    monthly: String(retention.monthly),
    yearly: String(retention.yearly),
  };
}

/** Values of a new source, or of an existing one to edit. */
export function initialValues(source?: Source): SourceFormValues {
  const schedule = source?.schedule ?? DEFAULT_SCHEDULE;
  const drive = source?.kind === "google_drive" ? source.config : null;
  const personio = source?.kind === "personio" ? source.config : null;
  const s3 = source?.kind === "s3_bucket" ? source.config : null;
  return {
    name: source?.name ?? "",
    enabled: source?.enabled ?? true,
    scheduleType: schedule.type,
    every: schedule.type === "hourly" ? schedule.every : 6,
    minute: schedule.type === "hourly" ? String(schedule.minute) : "0",
    time: schedule.type === "hourly" ? "02:00" : schedule.time,
    day: schedule.type === "weekly" ? schedule.day : 0,
    retention: retentionStrings(source?.retention ?? DEFAULT_RETENTION),
    subject: drive?.subject ?? "",
    scopeType: drive?.scope.type ?? "shared_drive",
    driveId: drive?.scope.type === "shared_drive" ? drive.scope.driveId : "",
    folders:
      drive?.scope.type === "folders"
        ? drive.scope.folders.map((folder) => folderRow(folder.id, folder.label))
        : [folderRow()],
    serviceAccountKey: "",
    baseUrl: personio?.baseUrl ?? DEFAULT_PERSONIO_URL,
    clientId: personio?.clientId ?? "",
    documents: personio?.documents ?? true,
    clientSecret: initialSecret(personio?.clientSecretHint != null),
    endpoint: s3?.endpoint ?? "",
    region: s3?.region ?? "",
    bucket: s3?.bucket ?? "",
    prefix: s3?.prefix ?? "",
    accessKeyId: s3?.accessKeyId ?? "",
    secretAccessKey: initialSecret(s3?.secretAccessKeyHint != null),
  };
}

/** A whole number from a field; blank is 0 for counts, anything else stays invalid (NaN). */
function count(value: string): number {
  return value.trim() === "" ? 0 : Number(value);
}

export function scheduleOf(values: SourceFormValues): Schedule {
  if (values.scheduleType === "hourly") {
    return {
      type: "hourly",
      every: values.every,
      minute: values.minute.trim() === "" ? Number.NaN : Number(values.minute),
    };
  }
  if (values.scheduleType === "daily") return { type: "daily", time: values.time };
  return { type: "weekly", day: values.day, time: values.time };
}

/** The API input of the form. Blank secrets are left out, so the stored ones stay. */
export function toSourceInput(kind: SourceKind, values: SourceFormValues): SourceInput {
  const base = {
    name: values.name,
    enabled: values.enabled,
    schedule: scheduleOf(values),
    retention: {
      daily: count(values.retention.daily),
      weekly: count(values.retention.weekly),
      monthly: count(values.retention.monthly),
      yearly: count(values.retention.yearly),
    },
  };
  if (kind === "app") return { ...base, kind, config: {} };
  if (kind === "google_drive") {
    const key = values.serviceAccountKey.trim();
    return {
      ...base,
      kind,
      config: {
        subject: values.subject,
        scope:
          values.scopeType === "shared_drive"
            ? { type: "shared_drive", driveId: values.driveId }
            : { type: "folders", folders: values.folders.map(({ id, label }) => ({ id, label })) },
      },
      secrets: key ? { serviceAccountKey: key } : {},
    };
  }
  if (kind === "s3_bucket") {
    const secret = secretPayload(values.secretAccessKey);
    return {
      ...base,
      kind,
      config: {
        endpoint: values.endpoint,
        region: values.region,
        bucket: values.bucket,
        prefix: values.prefix,
        accessKeyId: values.accessKeyId,
      },
      secrets: secret ? { secretAccessKey: secret } : {},
    };
  }
  const secret = secretPayload(values.clientSecret);
  return {
    ...base,
    kind,
    config: { baseUrl: values.baseUrl, clientId: values.clientId, documents: values.documents },
    secrets: secret ? { clientSecret: secret } : {},
  };
}

/** A source's current settings as input, without secrets (they stay stored), e.g. to pause it. */
export function sourceToInput(source: Source, changes: { enabled?: boolean } = {}): SourceInput {
  const base = {
    name: source.name,
    enabled: changes.enabled ?? source.enabled,
    schedule: source.schedule,
    retention: source.retention,
  };
  if (source.kind === "app") return { ...base, kind: "app", config: {} };
  if (source.kind === "google_drive") {
    return {
      ...base,
      kind: "google_drive",
      config: { subject: source.config.subject, scope: source.config.scope },
    };
  }
  if (source.kind === "s3_bucket") {
    const { endpoint, region, bucket, prefix, accessKeyId } = source.config;
    return { ...base, kind: "s3_bucket", config: { endpoint, region, bucket, prefix, accessKeyId } };
  }
  return {
    ...base,
    kind: "personio",
    config: {
      baseUrl: source.config.baseUrl,
      clientId: source.config.clientId,
      documents: source.config.documents,
    },
  };
}

/** client_id and client_email of a pasted service account key, when it reads as one. */
export function readServiceAccountKey(
  text: string,
): { clientId: string | null; email: string | null } | null {
  if (!text.trim()) return null;
  try {
    const key = JSON.parse(text) as { client_id?: unknown; client_email?: unknown };
    if (typeof key !== "object" || key === null) return null;
    return {
      clientId: typeof key.client_id === "string" ? key.client_id : null,
      email: typeof key.client_email === "string" ? key.client_email : null,
    };
  } catch {
    return null;
  }
}
