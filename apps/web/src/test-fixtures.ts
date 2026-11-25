import type { Dashboard } from "@backup/shared/api/dashboard";
import { DEFAULT_NOTIFICATIONS, type Notifications } from "@backup/shared/api/notifications";
import type { Run } from "@backup/shared/api/runs";
import { DEFAULT_RETENTION, DEFAULT_SCHEDULE } from "@backup/shared/api/schedule";
import type { AgentInfo, Source } from "@backup/shared/api/sources";
import type { Target } from "@backup/shared/api/target";

/** Answers of the API for tests, with overrides. */

export const IDS = {
  app: "0b5a3e5e-3c1f-4d8e-9f3a-000000000001",
  drive: "0b5a3e5e-3c1f-4d8e-9f3a-000000000002",
  personio: "0b5a3e5e-3c1f-4d8e-9f3a-000000000003",
  s3: "0b5a3e5e-3c1f-4d8e-9f3a-000000000004",
  run: "0b5a3e5e-3c1f-4d8e-9f3a-0000000000a1",
};

const base = {
  enabled: true,
  schedule: DEFAULT_SCHEDULE,
  retention: DEFAULT_RETENTION,
  status: "ok" as const,
  lastRun: null,
  lastSuccessAt: "2026-11-20T02:00:00.000Z",
  lastSnapshot: { id: "a1b2c3d4", time: "2026-11-20T02:00:00.000Z", bytes: 5 * 1024 ** 3, files: 1200 },
  nextRunAt: "2026-11-21T02:00:00.000Z",
  createdAt: "2026-11-01T10:00:00.000Z",
};

export function agentInfo(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    lastSeenAt: "2026-11-20T09:00:00.000Z",
    version: "1.0.0",
    appName: "wiki",
    appImage: "ghcr.io/example/wiki:1.4.0",
    database: true,
    volumes: ["files"],
    secrets: [],
    tokenHint: "x9Yz",
    ...overrides,
  };
}

export function appSource(overrides: Partial<Extract<Source, { kind: "app" }>> = {}): Source {
  return {
    ...base,
    id: IDS.app,
    name: "Wiki",
    kind: "app",
    config: {},
    agent: agentInfo(),
    ...overrides,
  };
}

export function driveSource(overrides: Partial<Extract<Source, { kind: "google_drive" }>> = {}): Source {
  return {
    ...base,
    id: IDS.drive,
    name: "Team drive",
    kind: "google_drive",
    config: {
      subject: "backup@example.org",
      scope: { type: "shared_drive", driveId: "0AbCdEfGhIjKlMnOp" },
      serviceAccountEmail: "backups@project.iam.gserviceaccount.com",
      serviceAccountClientId: "112233445566778899",
    },
    agent: null,
    ...overrides,
  };
}

export function personioSource(overrides: Partial<Extract<Source, { kind: "personio" }>> = {}): Source {
  return {
    ...base,
    id: IDS.personio,
    name: "People",
    kind: "personio",
    config: {
      baseUrl: "https://api.personio.de",
      clientId: "papi-123",
      documents: true,
      clientSecretHint: "…f00d",
    },
    agent: null,
    ...overrides,
  };
}

export function s3Source(overrides: Partial<Extract<Source, { kind: "s3_bucket" }>> = {}): Source {
  return {
    ...base,
    id: IDS.s3,
    name: "Media files",
    kind: "s3_bucket",
    config: {
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      bucket: "acme-media",
      prefix: "originals",
      accessKeyId: "MEDIAREAD",
      secretAccessKeyHint: "…b33f",
    },
    agent: null,
    ...overrides,
  };
}

export function run(overrides: Partial<Run> = {}): Run {
  return {
    id: IDS.run,
    kind: "backup",
    sourceId: IDS.app,
    sourceName: "Wiki",
    sourceKind: "app",
    trigger: "schedule",
    status: "succeeded",
    queuedAt: "2026-11-20T02:00:00.000Z",
    startedAt: "2026-11-20T02:00:05.000Z",
    finishedAt: "2026-11-20T02:03:25.000Z",
    snapshotId: "a1b2c3d4",
    stats: {
      bytesProcessed: 2 * 1024 ** 3,
      bytesAdded: 12 * 1024 ** 2,
      filesProcessed: 1200,
      filesNew: 3,
      filesChanged: 5,
    },
    warnings: [],
    error: null,
    ...overrides,
  };
}

export function target(overrides: Partial<Target> = {}): Target {
  return {
    configured: true,
    endpoint: "https://fsn1.your-objectstorage.com",
    region: "fsn1",
    bucket: "acme-backups",
    prefix: "",
    accessKeyId: "AKIA123",
    secretAccessKeyHint: "…9f2a",
    repositoryUrl: "s3:https://fsn1.your-objectstorage.com/acme-backups",
    repository: { state: "ready", message: null, checkedAt: "2026-11-20T08:00:00.000Z", hasPassword: true },
    recoveryKitConfirmedAt: null,
    protection: {
      checkedAt: "2026-11-20T08:00:00.000Z",
      versioning: "enabled",
      objectLock: { enabled: true, mode: "COMPLIANCE", days: 30 },
      lifecycle: { noncurrentDays: 31, expiredDeleteMarkers: true, abortMultipartDays: 7 },
      error: null,
    },
    stats: { checkedAt: "2026-11-20T03:00:00.000Z", storedBytes: 42 * 1024 ** 3, snapshots: 120 },
    lastCheck: { at: "2026-11-20T03:30:00.000Z", ok: true, readData: "5%", message: null },
    maintenanceTime: "03:00",
    timezone: "Europe/Berlin",
    ...overrides,
  };
}

export function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    sources: [appSource()],
    target: target(),
    maintenance: run({ kind: "maintenance", sourceId: null, sourceName: "Repository upkeep" }),
    selfBackup: null,
    recentRuns: [run()],
    attention: [],
    ...overrides,
  };
}

export function notifications(overrides: Partial<Notifications> = {}): Notifications {
  return { ...DEFAULT_NOTIFICATIONS, ...overrides };
}
