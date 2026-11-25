import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backup/shared/api/schedule";
import { getDb } from "../db/client";
import {
  forgetByPolicy,
  listSnapshots,
  runRestic,
  SNAPSHOT_HOST,
  sourceTag,
  startStreamBackup,
  type Repository,
} from "../restic/restic";
import { openRepository } from "../target/target";
import { createUser, request, resetDatabase, setUpTarget } from "../test/helpers";
import { STREAM_FILENAME } from "./agent";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/** A snapshot as an earlier installation made it: another host name, months before. */
async function earlierSnapshot(repository: Repository, tag: string, content: string) {
  const result = await runRestic(repository, [
    "backup",
    "--host",
    "earlier-host",
    "--tag",
    tag,
    "--time",
    "2026-01-01 03:00:00",
    "--stdin-filename",
    STREAM_FILENAME,
    "--stdin-from-command",
    "--",
    "printf",
    content,
  ]);
  expect(result.code).toBe(0);
}

async function hostsOf(repository: Repository, tag: string) {
  const result = await runRestic(repository, ["snapshots", "--json", "--no-lock", "--tag", tag]);
  return (JSON.parse(result.stdout) as { hostname: string }[]).map((item) => item.hostname).sort();
}

describe("a repository taken over from an earlier installation", () => {
  beforeEach(resetDatabase);

  it("treats a source's snapshots under another host name as one series with its new ones", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const repository = await openRepository(getDb());
    const created = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "app",
        name: "Wiki",
        schedule: { type: "daily", time: "02:00" },
        retention: DEFAULT_RETENTION,
      },
    });
    const id = created.body.source.id as string;
    const tag = sourceTag(id);

    await earlierSnapshot(repository, tag, "the earlier stream");
    const backup = await startStreamBackup(repository, { tag, filename: STREAM_FILENAME });
    await backup.write(Buffer.from("the new stream"));
    await backup.finish();
    expect(await hostsOf(repository, tag)).toEqual([SNAPSHOT_HOST, "earlier-host"].sort());

    // Listing and downloads: both snapshots, newest first.
    const list = await request("GET", `/api/v1/sources/${id}/snapshots`, { userId: admin.id });
    expect(list.body.items).toHaveLength(2);
    const earlier = list.body.items[1];
    expect(earlier.time < "2026-01-02").toBe(true);
    const download = await request("GET", `/api/v1/sources/${id}/snapshots/${earlier.id}/download`, {
      userId: admin.id,
    });
    expect(download.status).toBe(200);
    expect(download.bytes.toString()).toBe("the earlier stream");

    // The recovery kit selects by tag, never by host.
    const kit = await request("GET", "/api/v1/target/recovery-kit", { userId: admin.id });
    expect(kit.body).toContain("restic snapshots --tag source:<id>");
    expect(kit.body).not.toContain("--host");

    // Retention: one series. Keeping only the newest snapshot leaves one, not one per host.
    await forgetByPolicy(repository, {
      tag,
      retention: { daily: 0, weekly: 0, monthly: 0, yearly: 0 },
    });
    const kept = await listSnapshots(repository, tag);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id.slice(0, 8)).toBe(list.body.items[0].id);
    expect(await hostsOf(repository, tag)).toEqual([SNAPSHOT_HOST]);
  });
});
