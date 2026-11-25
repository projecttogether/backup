import path from "node:path";
import { text } from "node:stream/consumers";
import { AwsClient } from "aws4fetch";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backup/shared/api/schedule";
import { getDb } from "../db/client";
import { runs } from "../db/schema";
import { dumpSnapshot, listSnapshots, sourceTag } from "../restic/restic";
import { openRepository } from "../target/target";
import { createUser, request, resetDatabase, setUpTarget, TEST_S3 } from "../test/helpers";
import { executeNext } from "../worker/execute";
import { stagingDir } from "./google-drive";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/** A bucket of an app (beside the test target's bucket), in the S3 storage of compose.dev.yaml. */
const BUCKET = "source-test";
const s3 = new AwsClient({
  accessKeyId: TEST_S3.accessKeyId,
  secretAccessKey: TEST_S3.secretAccessKey,
  service: "s3",
  region: TEST_S3.region,
});

async function put(key: string, body: string) {
  const response = await s3.fetch(`${TEST_S3.endpoint}/${BUCKET}/${key}`, { method: "PUT", body });
  expect(response.status).toBe(200);
}

describe("the S3 bucket source, with rclone, restic and S3", () => {
  beforeEach(resetDatabase);

  it("counts the objects in the folder, saves them as a snapshot, and fails without saving when the key stops working", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const created = await s3.fetch(`${TEST_S3.endpoint}/${BUCKET}`, { method: "PUT" });
    expect([200, 409]).toContain(created.status);
    const folder = `run-${Date.now().toString(36)}`;
    await put(`${folder}/media/originals/a.jpg`, "photo A");
    await put(`${folder}/media/originals/sub/b.pdf`, "document B");
    await put(`${folder}/other/c.txt`, "not in the folder");
    // An object named like the folder: the source still copies what is in the folder.
    await put(`${folder}/media`, "an object named like the folder");

    const body = {
      kind: "s3_bucket",
      name: "Media files",
      schedule: { type: "daily", time: "02:00" },
      retention: DEFAULT_RETENTION,
      config: {
        endpoint: TEST_S3.endpoint,
        region: TEST_S3.region,
        bucket: BUCKET,
        prefix: `${folder}/media`,
        accessKeyId: TEST_S3.accessKeyId,
      },
      secrets: { secretAccessKey: TEST_S3.secretAccessKey },
    };
    const source = await request("POST", "/api/v1/sources", { userId: admin.id, body });
    expect(source.status).toBe(201);
    expect(source.body.source.config.secretAccessKeyHint).toMatch(/^…/);
    expect(JSON.stringify(source.body)).not.toContain(TEST_S3.secretAccessKey);
    const id = source.body.source.id as string;

    const test = await request("POST", `/api/v1/sources/${id}/test`, { userId: admin.id, body: {} });
    expect(test.body).toMatchObject({ ok: true, items: 2, bytes: "photo A".length + "document B".length });

    const backup = async () => {
      const queued = await request("POST", `/api/v1/sources/${id}/run`, { userId: admin.id, body: {} });
      expect(queued.status).toBe(202);
      expect(await executeNext(getDb())).toBe(true);
      const [run] = await getDb()
        .select()
        .from(runs)
        .where(eq(runs.id, queued.body.id as string));
      return run!;
    };
    const first = await backup();
    expect(first.error).toBeNull();
    expect(first.status).toBe("succeeded");
    const repository = await openRepository(getDb());
    const snapshots = await listSnapshots(repository, sourceTag(id));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.files).toBe(2);
    const dump = dumpSnapshot(repository, {
      snapshotId: snapshots[0]!.id,
      path: path.join(stagingDir(id), "originals/sub/b.pdf"),
    });
    expect(await text(dump.stream)).toBe("document B");
    await dump.done;

    // A key that stops working fails the run before restic runs: the old copy is not saved again.
    const changed = await request("PUT", `/api/v1/sources/${id}`, {
      userId: admin.id,
      body: { ...body, secrets: { secretAccessKey: "not-the-secret-key" } },
    });
    expect(changed.status).toBe(200);
    const second = await backup();
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/^Copying the bucket failed: /);
    expect(await listSnapshots(repository, sourceTag(id))).toHaveLength(1);
  });
});
