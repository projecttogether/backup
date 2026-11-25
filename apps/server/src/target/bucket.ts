import { AwsClient } from "aws4fetch";
import type { BucketProtection } from "@backup/shared/api/target";

/*
 * What the bucket's own settings protect, read with three S3 calls:
 * versioning, Object Lock (with its default retention) and the lifecycle
 * rules. restic does not need any of them; they decide whether data that
 * restic (or a stolen key) deletes can still be recovered, and whether old
 * versions are ever removed (and stop costing money).
 */

type Bucket = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]?.trim() ?? null;
const blocks = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((match) => match[1]!);

export function parseVersioning(xml: string): BucketProtection["versioning"] {
  const status = tag(xml, "Status");
  return status === "Enabled" ? "enabled" : status === "Suspended" ? "suspended" : "off";
}

export function parseObjectLock(xml: string): NonNullable<BucketProtection["objectLock"]> {
  const enabled = tag(xml, "ObjectLockEnabled") === "Enabled";
  const mode = tag(xml, "Mode");
  const days = tag(xml, "Days");
  const years = tag(xml, "Years");
  return {
    enabled,
    mode: mode === "GOVERNANCE" || mode === "COMPLIANCE" ? mode : null,
    days: days ? Number(days) : years ? Number(years) * 365 : null,
  };
}

/** The enabled rules that apply to the whole bucket (no prefix or an empty one). */
export function parseLifecycle(xml: string): NonNullable<BucketProtection["lifecycle"]> {
  let noncurrentDays: number | null = null;
  let expiredDeleteMarkers = false;
  let abortMultipartDays: number | null = null;
  for (const rule of blocks(xml, "Rule")) {
    if (tag(rule, "Status") !== "Enabled") continue;
    const prefix = tag(rule, "Prefix");
    if (prefix) continue;
    const noncurrent = blocks(rule, "NoncurrentVersionExpiration")[0];
    const days = noncurrent ? tag(noncurrent, "NoncurrentDays") : null;
    if (days) noncurrentDays = Math.min(noncurrentDays ?? Infinity, Number(days));
    const expiration = blocks(rule, "Expiration")[0];
    if (expiration && tag(expiration, "ExpiredObjectDeleteMarker") === "true") expiredDeleteMarkers = true;
    const abort = blocks(rule, "AbortIncompleteMultipartUpload")[0];
    const abortDays = abort ? tag(abort, "DaysAfterInitiation") : null;
    if (abortDays) abortMultipartDays = Math.min(abortMultipartDays ?? Infinity, Number(abortDays));
  }
  return { noncurrentDays, expiredDeleteMarkers, abortMultipartDays };
}

function errorCode(xml: string): string | null {
  return tag(xml, "Code");
}

export async function readBucketProtection(target: Bucket): Promise<BucketProtection> {
  const client = new AwsClient({
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    service: "s3",
    region: target.region || "us-east-1",
  });
  const base = `${target.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(target.bucket)}`;
  const get = async (query: string) => {
    const response = await client.fetch(`${base}?${query}`, { signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.text() };
  };
  const protection: BucketProtection = {
    checkedAt: new Date().toISOString(),
    versioning: null,
    objectLock: null,
    lifecycle: null,
    error: null,
  };
  const problems: string[] = [];
  try {
    const versioning = await get("versioning");
    if (versioning.status === 200) protection.versioning = parseVersioning(versioning.body);
    else problems.push(`versioning: ${errorCode(versioning.body) ?? `HTTP ${versioning.status}`}`);

    const lock = await get("object-lock");
    if (lock.status === 200) protection.objectLock = parseObjectLock(lock.body);
    else if (lock.status === 404 || /ObjectLockConfigurationNotFound/.test(lock.body)) {
      protection.objectLock = { enabled: false, mode: null, days: null };
    } else problems.push(`Object Lock: ${errorCode(lock.body) ?? `HTTP ${lock.status}`}`);

    const lifecycle = await get("lifecycle");
    if (lifecycle.status === 200) protection.lifecycle = parseLifecycle(lifecycle.body);
    else if (lifecycle.status === 404 || /NoSuchLifecycleConfiguration/.test(lifecycle.body)) {
      protection.lifecycle = { noncurrentDays: null, expiredDeleteMarkers: false, abortMultipartDays: null };
    } else problems.push(`lifecycle: ${errorCode(lifecycle.body) ?? `HTTP ${lifecycle.status}`}`);
  } catch (error) {
    problems.push(
      (error as { name?: string }).name === "TimeoutError" ? "no answer within 20 seconds" : "not reachable",
    );
  }
  protection.error = problems.length > 0 ? `Could not read ${problems.join("; ")}` : null;
  return protection;
}
