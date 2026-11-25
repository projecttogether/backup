import { mkdir, readdir } from "node:fs/promises";
import type { S3BucketConfig, SourceTest } from "@backup/shared/api/sources";
import {
  checkRoom,
  freeBytes,
  itemErrors,
  rclone,
  rcloneSummary,
  stagingDir,
  type CopyResult,
} from "./google-drive";
import { sourceSecret, type SourceRow } from "./service";

/*
 * An S3-compatible bucket through rclone, for example the files an app keeps
 * in a bucket, which its backup agent does not see. The remote exists only in
 * rclone's environment (provider Other: endpoint, region, the key); rclone
 * only reads from it, and copies the bucket's objects (or those in one
 * folder) into the source's local copy. Each run fetches only the objects
 * whose size or upload time changed; restic then backs up the copy.
 */

/** The rclone remote of the source, and the bucket (and folder) on it. */
export function remoteOf(source: Pick<SourceRow, "config">, secretAccessKey: string) {
  const bucket = source.config as S3BucketConfig;
  const env: Record<string, string> = {
    RCLONE_CONFIG_S3SOURCE_TYPE: "s3",
    RCLONE_CONFIG_S3SOURCE_PROVIDER: "Other",
    RCLONE_CONFIG_S3SOURCE_ENDPOINT: bucket.endpoint,
    RCLONE_CONFIG_S3SOURCE_ACCESS_KEY_ID: bucket.accessKeyId,
    RCLONE_CONFIG_S3SOURCE_SECRET_ACCESS_KEY: secretAccessKey,
  };
  if (bucket.region) env.RCLONE_CONFIG_S3SOURCE_REGION = bucket.region;
  // The trailing slash makes the folder a folder: without it, an object with the folder's name
  // would be copied instead of what is in the folder.
  return { env, path: `s3source:${bucket.bucket}${bucket.prefix ? `/${bucket.prefix}/` : ""}` };
}

/** Counts the objects and their size; null when rclone failed (its errors say why). */
async function size(remote: ReturnType<typeof remoteOf>, signal: AbortSignal) {
  const result = await rclone(["size", remote.path, "--json", "--fast-list"], remote.env, signal);
  if (result.code !== 0) return { counted: null, result };
  const counted = JSON.parse(result.stdout || "{}") as { count?: number; bytes?: number };
  return { counted: { items: counted.count ?? 0, bytes: Math.max(0, counted.bytes ?? 0) }, result };
}

/** Can the key read the bucket, and how much is there? */
export async function testS3Bucket(source: SourceRow): Promise<SourceTest> {
  const remote = remoteOf(source, sourceSecret(source, "secretAccessKey"));
  const access = await rclone(
    ["lsf", remote.path, "--max-depth", "1"],
    remote.env,
    AbortSignal.timeout(60_000),
  );
  if (access.code !== 0) {
    return {
      ok: false,
      message: `The bucket refused: ${rcloneSummary(access.errors, `rclone exited with ${access.code}`)}`,
      items: null,
      bytes: null,
      freeBytes: null,
    };
  }
  const counting = AbortSignal.timeout(180_000);
  const { counted, result } = await size(remote, counting);
  if (!counted && !counting.aborted) {
    return {
      ok: false,
      message: `The bucket refused: ${rcloneSummary(result.errors, `rclone exited with ${result.code}`)}`,
      items: null,
      bytes: null,
      freeBytes: null,
    };
  }
  return {
    ok: true,
    message: !counted
      ? "The bucket answers. Counting the objects took too long; the first backup shows the size."
      : counted.items === 0
        ? "The bucket answers, but holds no objects here. Check the bucket's and the folder's names."
        : "The bucket answers.",
    items: counted?.items ?? null,
    bytes: counted?.bytes ?? null,
    freeBytes: await freeBytes(stagingDir(source.id)),
  };
}

/**
 * Brings the local copy up to date. Errors about single objects become
 * warnings; any other error fails the copy before restic runs.
 */
export async function copyS3Bucket(
  source: SourceRow,
  options: { signal: AbortSignal; log: (line: string) => Promise<void> },
): Promise<CopyResult> {
  const remote = remoteOf(source, sourceSecret(source, "secretAccessKey"));
  const root = stagingDir(source.id);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length === 0) {
    const { counted, result } = await size(remote, options.signal);
    if (!counted) {
      throw new Error(
        `The bucket refused: ${rcloneSummary(result.errors, `rclone exited with ${result.code}`)}`,
      );
    }
    await checkRoom(root, counted.bytes);
    await options.log(`First copy: about ${Math.ceil(counted.bytes / 1e6)} MB in the bucket`);
  }
  await options.log("Copying the bucket");
  // The server's upload time stands for the modification time: no extra request per object.
  const result = await rclone(
    ["sync", remote.path, root, "--fast-list", "--use-server-modtime", "--stats", "0"],
    remote.env,
    options.signal,
  );
  if (options.signal.aborted) throw new Error("Stopped");
  const items = itemErrors(result, "Copying the bucket");
  return {
    // rclone deletes nothing after such errors: objects deleted from the bucket stay until a run without errors.
    warnings:
      items.length > 0
        ? [
            `${items.length} object(s) could not be copied; objects deleted from the bucket stay in this backup`,
          ]
        : [],
    errors: items.map((error) => `${error.object}: ${error.message}`.slice(0, 500)),
  };
}
