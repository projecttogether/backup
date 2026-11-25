import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { Retention } from "@backup/shared/api/schedule";
import type { RunStats } from "@backup/shared/api/runs";
import { config } from "../config";
import { logger } from "../logger";

/*
 * restic does the backup work: encryption, deduplication, compression,
 * snapshots, retention and integrity checks. This module runs the restic
 * program with the repository's settings in its environment (never in its
 * arguments, which other processes can read) and without the app's own
 * environment (database URL, secrets).
 */

/** Where restic stores and how it opens the repository. */
export type Repository = {
  /** e.g. s3:https://fsn1.your-objectstorage.com/bucket/prefix */
  url: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  password: string;
};

/**
 * The host name of new snapshots, so that it never depends on the
 * container's name. Snapshots of a repository taken over from an earlier
 * installation carry another host name: everything selects and groups
 * snapshots by their tag (`source:<id>`), never by host, so a source's old
 * and new snapshots are one series.
 */
export const SNAPSHOT_HOST = "backup";

export const sourceTag = (sourceId: string) => `source:${sourceId}`;
export const SELF_TAG = "source:self";

/** A failed restic command. `message` is safe to show admins (no secrets). */
export class ResticError extends Error {
  override name = "ResticError";
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

/** restic's exit codes (restic help): 3 = snapshot saved, some files not read; 10 = no repository; 11 = locked; 12 = wrong password. */
export const EXIT = {
  ok: 0,
  incomplete: 3,
  noRepository: 10,
  locked: 11,
  wrongPassword: 12,
  interrupted: 130,
};

export function repositoryUrl(target: { endpoint: string; bucket: string; prefix: string }): string {
  const endpoint = target.endpoint.replace(/\/+$/, "");
  return `s3:${endpoint}/${target.bucket}${target.prefix ? `/${target.prefix}` : ""}`;
}

function cacheDir() {
  return path.resolve(config().DATA_DIR, "cache");
}

/** The environment of a restic process: the repository and nothing of the app's own settings. */
export function resticEnv(repository: Repository, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: path.resolve(config().DATA_DIR),
    TZ: config().TZ,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    RESTIC_REPOSITORY: repository.url,
    RESTIC_PASSWORD: repository.password,
    RESTIC_CACHE_DIR: cacheDir(),
    RESTIC_PROGRESS_FPS: "0.016",
    AWS_ACCESS_KEY_ID: repository.accessKeyId,
    AWS_SECRET_ACCESS_KEY: repository.secretAccessKey,
    ...(repository.region ? { AWS_DEFAULT_REGION: repository.region } : {}),
    ...extra,
  };
}

/** The last meaningful line restic wrote to stderr, without anything that looks like a secret. */
export function errorLine(stderr: string, fallback: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(\{|repository [0-9a-f]+ opened|created restic repository)/.test(line));
  const line = lines.at(-1) ?? fallback;
  return redact(line).slice(0, 500);
}

/** Removes credentials from a message: URL user info, keys after "=", long base64 runs. */
export function redact(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^/@\s]+@/g, "$1***@")
    .replace(/((?:password|secret|key|token)\s*[=:]\s*)\S+/gi, "$1***");
}

type RunOptions = {
  signal?: AbortSignal;
  /** Called for each stdout line (JSON messages with --json). */
  onLine?: (line: string) => void;
  /** Keep stdout (default: true; false for large outputs read through onLine). */
  collect?: boolean;
  env?: Record<string, string>;
};

type RunResult = { code: number | null; stdout: string; stderr: string };

function spawnRestic(repository: Repository, args: string[], env: Record<string, string> = {}) {
  return spawn(config().RESTIC_BINARY, args, {
    env: resticEnv(repository, env),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Stops a restic process: SIGINT first (restic saves no snapshot and removes
 * its locks), SIGKILL after `killAfterMs`.
 */
function stop(child: ChildProcessWithoutNullStreams, killAfterMs = 30_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  const timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
  timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

function collectOutput(child: ChildProcessWithoutNullStreams, options: RunOptions) {
  let stdout = "";
  let stderr = "";
  let partial = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (options.collect !== false) stdout += chunk;
    if (options.onLine) {
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) options.onLine(line);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    // Keep the end: the reason of a failure is in the last lines.
    stderr = (stderr + chunk).slice(-20_000);
  });
  const done = new Promise<RunResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (options.onLine && partial.trim()) options.onLine(partial);
      resolve({ code, stdout, stderr });
    });
  });
  return done;
}

/** Runs restic once and returns its exit code and output. Rejects only when restic cannot start. */
export async function runRestic(repository: Repository, args: string[], options: RunOptions = {}) {
  options.signal?.throwIfAborted();
  await mkdir(cacheDir(), { recursive: true });
  // An abort may come while the folder is made: never start restic after it.
  options.signal?.throwIfAborted();
  const child = spawnRestic(repository, args, options.env);
  child.stdin.end();
  const abort = () => stop(child);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    return await collectOutput(child, options);
  } catch (error) {
    throw new ResticError(
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "The restic program is not installed"
        : "restic could not start",
      null,
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

async function runOrThrow(repository: Repository, args: string[], what: string, options: RunOptions = {}) {
  const result = await runRestic(repository, args, options);
  if (result.code !== 0) {
    throw new ResticError(
      `${what}: ${errorLine(result.stderr, `restic exited with ${result.code}`)}`,
      result.code,
    );
  }
  return result;
}

export type RepositoryProbe =
  | { state: "ready" }
  | { state: "missing" }
  | { state: "wrong_password" }
  | { state: "error"; message: string };

/** Whether a repository exists at the location and the password opens it. */
export async function probeRepository(
  repository: Repository,
  signal?: AbortSignal,
): Promise<RepositoryProbe> {
  const result = await runRestic(repository, ["cat", "config", "--no-lock"], {
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  if (result.code === 0) return { state: "ready" };
  if (result.code === EXIT.noRepository) return { state: "missing" };
  if (result.code === EXIT.wrongPassword) return { state: "wrong_password" };
  return { state: "error", message: errorLine(result.stderr, "The repository could not be opened") };
}

export async function initRepository(repository: Repository) {
  await runOrThrow(repository, ["init"], "The repository could not be created", {
    signal: AbortSignal.timeout(300_000),
  });
}

/** restic's backup summary (`--json`, message_type summary). */
type Summary = {
  snapshot_id?: string;
  files_new?: number;
  files_changed?: number;
  data_added?: number;
  total_files_processed?: number;
  total_bytes_processed?: number;
};

export type BackupResult = {
  snapshotId: string;
  stats: RunStats;
  /** Items restic could not read (exit code 3): the snapshot exists without them. */
  incomplete: boolean;
  errors: string[];
};

function statsOf(summary: Summary): RunStats {
  return {
    bytesProcessed: summary.total_bytes_processed ?? null,
    bytesAdded: summary.data_added ?? null,
    filesProcessed: summary.total_files_processed ?? null,
    filesNew: summary.files_new ?? null,
    filesChanged: summary.files_changed ?? null,
  };
}

/** Reads restic's JSON messages of a backup: the summary and per-item errors. */
function backupReader() {
  let summary: Summary | null = null;
  const errors: string[] = [];
  return {
    onLine(line: string) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.message_type === "summary") summary = message as Summary;
      if (message.message_type === "error" && errors.length < 200) {
        const error = message.error as { message?: unknown } | string | undefined;
        const text = typeof error === "string" ? error : String(error?.message ?? "unknown error");
        const item = typeof message.item === "string" ? `${message.item}: ` : "";
        errors.push(redact(`${item}${text}`).slice(0, 500));
      }
    },
    result(code: number | null, stderr: string): BackupResult {
      if ((code === 0 || code === EXIT.incomplete) && summary?.snapshot_id) {
        return {
          snapshotId: summary.snapshot_id,
          stats: statsOf(summary),
          incomplete: code === EXIT.incomplete,
          errors,
        };
      }
      if (code === EXIT.interrupted) throw new ResticError("The backup was stopped", code);
      throw new ResticError(
        `The backup failed: ${errors.at(-1) ?? errorLine(stderr, `restic exited with ${code}`)}`,
        code,
      );
    },
  };
}

const backupArgs = (tag: string) => [
  "backup",
  "--json",
  "--host",
  SNAPSHOT_HOST,
  "--tag",
  tag,
  // Another backup or the upkeep may hold the repository for a while.
  "--retry-lock",
  "30m",
];

/** Backs up a directory (a local copy of Google Drive or Personio). */
export async function backupDirectory(
  repository: Repository,
  options: { tag: string; directory: string; signal?: AbortSignal },
): Promise<BackupResult> {
  const reader = backupReader();
  const result = await runRestic(repository, [...backupArgs(options.tag), options.directory], {
    signal: options.signal,
    onLine: reader.onLine,
    collect: false,
  });
  return reader.result(result.code, result.stderr);
}

/** Backs up the output of a command (this app's pg_dump), as one file; no snapshot when the command fails. */
export async function backupCommandOutput(
  repository: Repository,
  options: {
    tag: string;
    filename: string;
    command: string[];
    env?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<BackupResult> {
  const reader = backupReader();
  const result = await runRestic(
    repository,
    [
      ...backupArgs(options.tag),
      "--stdin-filename",
      options.filename,
      "--stdin-from-command",
      "--",
      ...options.command,
    ],
    { signal: options.signal, onLine: reader.onLine, collect: false, env: options.env },
  );
  return reader.result(result.code, result.stderr);
}

/**
 * A backup of a stream that arrives in parts (an agent's upload): `write`
 * waits until restic took each part; `finish` ends the input and waits for
 * the snapshot; `abort` stops restic before the end, so no snapshot of an
 * incomplete stream is written.
 */
export type StreamBackup = {
  write(chunk: Buffer): Promise<void>;
  finish(): Promise<BackupResult>;
  abort(): void;
  /** Settles when restic ended, however it ended. */
  ended: Promise<void>;
};

export async function startStreamBackup(
  repository: Repository,
  options: { tag: string; filename: string },
): Promise<StreamBackup> {
  await mkdir(cacheDir(), { recursive: true });
  const reader = backupReader();
  const child = spawnRestic(repository, [
    ...backupArgs(options.tag),
    "--stdin",
    "--stdin-filename",
    options.filename,
  ]);
  const output = collectOutput(child, { onLine: reader.onLine, collect: false });
  let failure: Error | null = null;
  child.stdin.on("error", (error) => {
    failure = error;
  });
  const exited = output.then(
    (result) => {
      if (result.code !== 0) failure ??= new Error("restic stopped");
      return result;
    },
    (error: unknown) => {
      failure ??= error as Error;
      return null;
    },
  );
  const fail = async (): Promise<never> => {
    const result = await exited;
    throw new ResticError(
      `The backup failed: ${result ? errorLine(result.stderr, `restic exited with ${result.code}`) : "restic could not start"}`,
      result?.code ?? null,
    );
  };
  return {
    async write(chunk) {
      if (failure || child.exitCode !== null) return fail();
      if (!child.stdin.write(chunk)) {
        await Promise.race([once(child.stdin, "drain"), exited]);
        if (failure || child.exitCode !== null) return fail();
      }
    },
    async finish() {
      child.stdin.end();
      const result = await exited;
      if (!result) return fail();
      return reader.result(result.code, result.stderr);
    },
    abort() {
      // Never close restic's input first: at the end of its input, restic saves
      // what it read as a snapshot. Interrupt it (it cannot react while it
      // waits for input, so kill it soon), and close the input once it ended.
      child.once("exit", () => child.stdin.destroy());
      stop(child, 2_000);
    },
    ended: exited.then(() => undefined),
  };
}

/** A snapshot as `restic snapshots --json` lists it. */
export type SnapshotInfo = {
  id: string;
  shortId: string;
  time: string;
  paths: string[];
  tags: string[];
  bytes: number | null;
  files: number | null;
};

export async function listSnapshots(
  repository: Repository,
  tag?: string,
  signal?: AbortSignal,
): Promise<SnapshotInfo[]> {
  const args = ["snapshots", "--json", "--no-lock", ...(tag ? ["--tag", tag] : [])];
  const timeout = AbortSignal.timeout(300_000);
  const result = await runOrThrow(repository, args, "The snapshots could not be listed", {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const raw = JSON.parse(result.stdout || "[]") as {
    id: string;
    short_id?: string;
    time: string;
    paths?: string[];
    tags?: string[];
    summary?: Summary;
  }[];
  return raw
    .map((item) => ({
      id: item.id,
      shortId: item.short_id ?? item.id.slice(0, 8),
      time: new Date(item.time).toISOString(),
      paths: item.paths ?? [],
      tags: item.tags ?? [],
      bytes: item.summary?.total_bytes_processed ?? null,
      files: item.summary?.total_files_processed ?? null,
    }))
    .sort((a, b) => (a.time < b.time ? 1 : -1));
}

/**
 * Streams a file or a folder of a snapshot: `restic dump`. A folder comes
 * as a tar or zip archive with its content at the root.
 */
export function dumpSnapshot(
  repository: Repository,
  options: { snapshotId: string; path: string; archive?: "tar" | "zip"; signal?: AbortSignal },
): { stream: Readable; done: Promise<void> } {
  const args = options.archive
    ? ["dump", "--archive", options.archive, `${options.snapshotId}:${options.path}`, "/"]
    : ["dump", options.snapshotId, options.path];
  const child = spawnRestic(repository, args);
  child.stdin.end();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-10_000);
  });
  options.signal?.addEventListener("abort", () => stop(child), { once: true });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new ResticError(`The download failed: ${errorLine(stderr, `restic exited with ${code}`)}`, code),
        );
    });
  });
  done.catch((error: unknown) => logger.warn({ err: error }, "restic dump failed"));
  return { stream: child.stdout, done };
}

/** Applies a source's retention (restic forget), per tag; the newest snapshot always stays. */
export async function forgetByPolicy(
  repository: Repository,
  options: { tag: string; retention: Retention; signal?: AbortSignal },
) {
  const { retention } = options;
  await runOrThrow(
    repository,
    [
      "forget",
      "--tag",
      options.tag,
      "--group-by",
      "tags",
      "--keep-last",
      "1",
      "--keep-daily",
      String(retention.daily),
      "--keep-weekly",
      String(retention.weekly),
      "--keep-monthly",
      String(retention.monthly),
      "--keep-yearly",
      String(retention.yearly),
      "--retry-lock",
      "30m",
    ],
    "Old snapshots could not be removed",
    { signal: options.signal },
  );
}

/** Forgets the given snapshots (a deleted source's); the next prune removes their data. */
export async function forgetSnapshots(repository: Repository, ids: string[], signal?: AbortSignal) {
  for (let index = 0; index < ids.length; index += 100) {
    await runOrThrow(
      repository,
      ["forget", "--retry-lock", "30m", ...ids.slice(index, index + 100)],
      "The snapshots could not be removed",
      { signal },
    );
  }
}

/** Removes data no snapshot uses any more. */
export async function prune(repository: Repository, signal?: AbortSignal) {
  await runOrThrow(repository, ["prune", "--max-unused", "10%", "--retry-lock", "2h"], "Prune failed", {
    signal,
  });
}

/** Checks the repository's structure, and with `readData` (e.g. "5%") reads and verifies that share of the data. */
export async function checkRepository(
  repository: Repository,
  options: { readData?: string; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; message: string | null }> {
  const args = [
    "check",
    "--retry-lock",
    "2h",
    ...(options.readData ? [`--read-data-subset=${options.readData}`] : []),
  ];
  const result = await runRestic(repository, args, { signal: options.signal });
  if (result.code === 0) return { ok: true, message: null };
  return { ok: false, message: errorLine(result.stderr, `restic check exited with ${result.code}`) };
}

/** The repository's size in the bucket (after deduplication and compression) and its snapshot count. */
export async function repositoryStats(
  repository: Repository,
  signal?: AbortSignal,
): Promise<{ storedBytes: number | null; snapshots: number | null }> {
  const result = await runOrThrow(
    repository,
    ["stats", "--mode", "raw-data", "--json", "--no-lock"],
    "Stats failed",
    {
      signal,
    },
  );
  const stats = JSON.parse(result.stdout) as { total_size?: number; snapshots_count?: number };
  return { storedBytes: stats.total_size ?? null, snapshots: stats.snapshots_count ?? null };
}
