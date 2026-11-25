import { spawn } from "node:child_process";
import { mkdir, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
import type { DriveConfig, SourceTest } from "@backup/shared/api/sources";
import { config } from "../config";
import { redact } from "../restic/restic";
import { parseServiceAccountKey, sourceSecret, type SourceRow } from "./service";

/*
 * Google Drive through rclone: a service account with domain-wide
 * delegation acts as a Workspace user (`subject`) with read-only access
 * (scope drive.readonly) and copies a shared drive or folders into the
 * source's local copy. rclone copies only what changed since the last run,
 * follows Google's rate limits and exports Google Docs, Sheets and Slides
 * as docx, xlsx and pptx. restic then backs up the local copy.
 */

/** Google Docs, Sheets, Slides and Drawings as Office files and SVG. */
const EXPORT_FORMATS = "docx,xlsx,pptx,svg";

type Remote = { env: Record<string, string>; target: string };

/** The rclone remote of each part of the source (the shared drive, or each folder) and its folder in the copy. */
export function remotesOf(source: Pick<SourceRow, "config">, key: string): Remote[] {
  const drive = source.config as DriveConfig;
  const base = {
    RCLONE_CONFIG_GDRIVE_TYPE: "drive",
    RCLONE_CONFIG_GDRIVE_SCOPE: "drive.readonly",
    RCLONE_CONFIG_GDRIVE_SERVICE_ACCOUNT_CREDENTIALS: JSON.stringify(JSON.parse(key)),
    RCLONE_CONFIG_GDRIVE_IMPERSONATE: drive.subject,
    RCLONE_CONFIG_GDRIVE_EXPORT_FORMATS: EXPORT_FORMATS,
    RCLONE_CONFIG_GDRIVE_SKIP_SHORTCUTS: "true",
  };
  if (drive.scope.type === "shared_drive") {
    return [{ env: { ...base, RCLONE_CONFIG_GDRIVE_TEAM_DRIVE: drive.scope.driveId }, target: "" }];
  }
  const used = new Set<string>();
  return drive.scope.folders.map((folder) => {
    let name = folderName(folder.label) || folder.id;
    for (let index = 2; used.has(name.toLowerCase()); index += 1)
      name = `${folderName(folder.label)} ${index}`;
    used.add(name.toLowerCase());
    return { env: { ...base, RCLONE_CONFIG_GDRIVE_ROOT_FOLDER_ID: folder.id }, target: name };
  });
}

/** A folder name safe on every file system. */
export function folderName(label: string): string {
  return (
    label
      // eslint-disable-next-line no-control-regex -- control characters are what this removes
      .replace(/[\u0000-\u001f/\\:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+/, "")
      .slice(0, 100)
      .trim()
  );
}

type RcloneResult = { code: number | null; stdout: string; errors: RcloneError[]; duplicates: string[] };
/**
 * An error rclone logged. `item`: about one file or folder (`object`);
 * `summary`: rclone's count of the item errors at the end of a try;
 * `general`: anything else (sign-in, listing the root, the copy itself).
 */
export type RcloneError = { message: string; object: string | null; kind: "item" | "summary" | "general" };

const SUMMARY = /^(Attempt \d+\/\d+ failed with \d+ errors|Failed to (sync|copy)(:| with \d+ errors))/;
/** A folder could not be listed: what the copy holds of it may be old, so the copy fails. */
const LISTING = /error reading (source|destination)|couldn't list|directory not found/i;
const DUPLICATE = /^Duplicate (object|directory) found in source/;
/** After item errors, sync leaves deleted files in the copy: a notice about the copy, not an item. */
const NOT_DELETING = /^not deleting (files|directories) as there were IO errors/;

/** Reads rclone's JSON log (stderr, --use-json-log): the errors, and the items skipped as duplicates. */
export function parseRcloneLog(text: string): { errors: RcloneError[]; duplicates: string[] } {
  const errors: RcloneError[] = [];
  const duplicates: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { level?: string; msg?: string; object?: string };
      const message = redact(String(entry.msg ?? "error")).slice(0, 500);
      const object = entry.object || null;
      // Drive allows several files with one name in a folder; rclone copies only one of them.
      if (DUPLICATE.test(message)) duplicates.push(object ?? message);
      else if (entry.level === "error" || entry.level === "critical") {
        errors.push({
          message,
          object,
          kind: LISTING.test(message)
            ? "general"
            : NOT_DELETING.test(message)
              ? "summary"
              : object
                ? "item"
                : SUMMARY.test(message)
                  ? "summary"
                  : "general",
        });
      }
    } catch {
      if (/error|failed/i.test(line)) {
        errors.push({ message: redact(line).slice(0, 500), object: null, kind: "general" });
      }
    }
  }
  return { errors, duplicates };
}

/** Runs rclone with no config file: its remote comes from `env` (RCLONE_CONFIG_<NAME>_*), never from arguments. */
export function rclone(
  args: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<RcloneResult> {
  return new Promise((resolve, reject) => {
    // An abort that came before (during an awaited step) fires no event: check it first.
    signal?.throwIfAborted();
    const child = spawn(
      config().RCLONE_BINARY,
      [...args, "--config", "", "--use-json-log", "--log-level", "NOTICE"],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: path.resolve(config().DATA_DIR),
          TZ: config().TZ,
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000_000);
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(
        new Error(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "The rclone program is not installed"
            : "rclone could not start",
        ),
      );
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve({ code, stdout, ...parseRcloneLog(stderr) });
    });
  });
}

/** Where the source's local copy lives. */
export function stagingDir(sourceId: string) {
  return path.resolve(config().DATA_DIR, "staging", sourceId);
}

export async function freeBytes(directory: string): Promise<number | null> {
  try {
    await mkdir(directory, { recursive: true });
    const stats = await statfs(directory);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** What went wrong, in one line: the first error that is not about a single file, else the first. */
export function rcloneSummary(errors: RcloneError[], fallback: string) {
  return (errors.find((error) => error.kind === "general") ?? errors[0])?.message ?? fallback;
}

/**
 * The errors about single items of an rclone copy, which the backup goes on
 * without. Any other error fails the copy (`what` failed: …), so a backup
 * never saves an outdated copy as if it were current.
 */
export function itemErrors(result: RcloneResult, what: string): RcloneError[] {
  const general = result.errors.filter((error) => error.kind === "general");
  const items = result.errors.filter((error) => error.kind === "item");
  if (result.code !== 0 && (general.length > 0 || items.length === 0)) {
    throw new Error(`${what} failed: ${rcloneSummary(result.errors, `rclone exited with ${result.code}`)}`);
  }
  return items;
}

/** Refuses a first copy of `needed` bytes that would nearly fill the data volume. */
export async function checkRoom(directory: string, needed: number) {
  const free = await freeBytes(directory);
  if (free !== null && needed > free * 0.9) {
    throw new Error(
      `The first copy needs about ${Math.ceil(needed / 1e9)} GB; ${Math.floor(free / 1e9)} GB are free in the data volume`,
    );
  }
}

/** Can the service account reach the drive or folders, and how much is there? */
export async function testDrive(source: SourceRow): Promise<SourceTest> {
  const key = sourceSecret(source, "serviceAccountKey");
  if (!parseServiceAccountKey(key)) {
    return {
      ok: false,
      message: "The stored key is not a service account key",
      items: null,
      bytes: null,
      freeBytes: null,
    };
  }
  let items = 0;
  let bytes = 0;
  for (const remote of remotesOf(source, key)) {
    const access = await rclone(
      ["lsf", "gdrive:", "--max-depth", "1"],
      remote.env,
      AbortSignal.timeout(60_000),
    );
    if (access.code !== 0) {
      return {
        ok: false,
        message: `Google Drive refused: ${rcloneSummary(access.errors, `rclone exited with ${access.code}`)}`,
        items: null,
        bytes: null,
        freeBytes: null,
      };
    }
    const size = await rclone(
      ["size", "gdrive:", "--json", "--fast-list"],
      remote.env,
      AbortSignal.timeout(180_000),
    );
    if (size.code === 0) {
      const counted = JSON.parse(size.stdout || "{}") as { count?: number; bytes?: number };
      items += counted.count ?? 0;
      bytes += Math.max(0, counted.bytes ?? 0);
    } else {
      return {
        ok: true,
        message: "Google Drive answers. Counting the files took too long; the first backup shows the size.",
        items: null,
        bytes: null,
        freeBytes: await freeBytes(stagingDir(source.id)),
      };
    }
  }
  return {
    ok: true,
    message:
      "Google Drive answers. Google Docs, Sheets and Slides count once exported, so the copy can be larger.",
    items,
    bytes,
    freeBytes: await freeBytes(stagingDir(source.id)),
  };
}

export type CopyResult = { warnings: string[]; errors: string[] };

/**
 * Brings the local copy up to date. Errors about single files become
 * warnings (the backup goes on without them); any other error fails the
 * copy, so a backup never saves an outdated copy as if it were current.
 */
export async function copyDrive(
  source: SourceRow,
  options: { signal: AbortSignal; log: (line: string) => Promise<void> },
): Promise<CopyResult> {
  const key = sourceSecret(source, "serviceAccountKey");
  const root = stagingDir(source.id);
  await mkdir(root, { recursive: true });
  const firstRun = (await readdir(root)).length === 0;
  const remotes = remotesOf(source, key);
  if (firstRun) {
    let needed = 0;
    for (const remote of remotes) {
      const size = await rclone(["size", "gdrive:", "--json", "--fast-list"], remote.env, options.signal);
      if (size.code !== 0)
        throw new Error(
          `Google Drive refused: ${rcloneSummary(size.errors, `rclone exited with ${size.code}`)}`,
        );
      needed += Math.max(0, (JSON.parse(size.stdout || "{}") as { bytes?: number }).bytes ?? 0);
    }
    await checkRoom(root, needed);
    await options.log(`First copy: about ${Math.ceil(needed / 1e6)} MB in Google Drive`);
  }
  const warnings: string[] = [];
  const errors: string[] = [];
  const active = new Set(remotes.map((remote) => remote.target));
  for (const remote of remotes) {
    const destination = remote.target ? path.join(root, remote.target) : root;
    await options.log(remote.target ? `Copying the folder ${remote.target}` : "Copying the shared drive");
    const args = ["sync", "gdrive:", destination, "--fast-list", "--create-empty-src-dirs", "--stats", "0"];
    // Folders: the copy holds one folder per configured folder; leave the others alone.
    const result = await rclone(args, remote.env, options.signal);
    if (options.signal.aborted) throw new Error("Stopped");
    const items = itemErrors(result, "Google Drive copy");
    const where = remote.target ? ` in ${remote.target}` : "";
    for (const error of items) errors.push(`${error.object}: ${error.message}`.slice(0, 500));
    if (items.length > 0) warnings.push(`${items.length} item(s) could not be copied${where}`);
    for (const name of result.duplicates)
      errors.push(`${name}: skipped, another item has the same name`.slice(0, 500));
    if (result.duplicates.length > 0) {
      warnings.push(
        `${result.duplicates.length} item(s) skipped${where}: another item in the same folder has the same name; rename them in Drive`,
      );
    }
  }
  // Folders that were removed from the source's setup leave the copy too.
  if ((source.config as DriveConfig).scope.type === "folders") {
    for (const entry of await readdir(root)) {
      if (!active.has(entry)) await rm(path.join(root, entry), { recursive: true, force: true });
    }
  }
  return { warnings, errors };
}
