import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backup/shared/api/schedule";
import { getDb } from "../db/client";
import { runs, sources } from "../db/schema";
import { resetConfigForTests } from "../config";
import { createUser, eventually, request, resetDatabase, setUpTarget } from "../test/helpers";
import { createRun } from "../runs/service";
import { getSourceRow } from "./service";
import {
  abortAllUploads,
  failJob,
  failOrphanedUploads,
  openUploadCount,
  resetStoppingForTests,
} from "./agent";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const PART = 1024 * 1024;

/** A stream as an agent sends it; the server does not look inside, restic stores it as backup.tar. */
function stream(bytes: number) {
  const data = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) data[index] = (index * 31 + (index >> 10)) & 0xff;
  return data;
}

const report = {
  agent: { version: "0.1.0" },
  app: { name: "wiki", image: "ghcr.io/example/wiki:0.3.1" },
  database: true,
  volumes: ["files"],
};

async function appSource(adminId: string) {
  const created = await request("POST", "/api/v1/sources", {
    userId: adminId,
    body: {
      kind: "app",
      name: "Wiki",
      schedule: { type: "daily", time: "02:00" },
      retention: DEFAULT_RETENTION,
    },
  });
  expect(created.status).toBe(201);
  return { id: created.body.source.id as string, token: created.body.token as string };
}

async function upload(token: string, jobId: string, data: Buffer) {
  let part = 0;
  for (let offset = 0; offset < data.length; offset += PART, part += 1) {
    const chunk = data.subarray(offset, offset + PART);
    const response = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/${part}`, {
      token,
      raw: chunk,
      headers: { "x-part-sha256": sha(chunk) },
    });
    expect(response.status).toBe(204);
  }
  return part;
}

describe("the agent protocol, with restic and S3", () => {
  beforeAll(() => {
    process.env.AGENT_PART_MB = "1";
    resetConfigForTests();
  });
  afterAll(() => {
    delete process.env.AGENT_PART_MB;
    resetConfigForTests();
  });
  beforeEach(resetDatabase);

  it("refuses wrong tokens", async () => {
    expect((await request("POST", "/api/agent/v1/poll", { body: report })).status).toBe(401);
    const wrong = `bkp_${"A".repeat(43)}`;
    expect((await request("POST", "/api/agent/v1/poll", { token: wrong, body: report })).status).toBe(401);
  });

  it("hands out a job, stores the stream as a snapshot, and serves it back", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const source = await appSource(admin.id);

    const idle = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
    expect(idle.status).toBe(200);
    expect(idle.body).toMatchObject({ source: { id: source.id, name: "Wiki" }, job: null });
    const [seen] = await getDb().select().from(sources).where(eq(sources.id, source.id));
    expect(seen!.agentInfo).toMatchObject({ version: "0.1.0", appName: "wiki", volumes: ["files"] });

    const queued = await request("POST", `/api/v1/sources/${source.id}/run`, { userId: admin.id, body: {} });
    expect(queued.status).toBe(202);
    // `check` never takes the job.
    const checked = await request("POST", "/api/agent/v1/poll", {
      token: source.token,
      body: { ...report, check: true },
    });
    expect(checked.body.job).toBeNull();
    const picked = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
    expect(picked.body.job).toEqual({ id: queued.body.id, partBytes: PART });
    const jobId = picked.body.job.id as string;

    expect(
      (
        await request("POST", `/api/agent/v1/jobs/${jobId}/progress`, {
          token: source.token,
          body: { stage: "database", bytes: 10 },
        })
      ).status,
    ).toBe(204);

    const data = stream(Math.round(2.5 * PART));
    const first = data.subarray(0, PART);
    // Out of order, damaged, then the real part and a repeat (lost answer).
    const outOfOrder = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/1`, {
      token: source.token,
      raw: first,
      headers: { "x-part-sha256": sha(first) },
    });
    expect(outOfOrder.status).toBe(409);
    expect(outOfOrder.body.error).toMatchObject({ code: "out_of_order", expected: 0 });
    const damaged = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/0`, {
      token: source.token,
      raw: first,
      headers: { "x-part-sha256": "0".repeat(64) },
    });
    expect(damaged.status).toBe(422);
    const parts = await upload(source.token, jobId, data);
    const again = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/${parts - 1}`, {
      token: source.token,
      raw: data.subarray((parts - 1) * PART),
      headers: { "x-part-sha256": sha(data.subarray((parts - 1) * PART)) },
    });
    expect(again.status).toBe(204);

    const totals = { parts, bytes: data.length, sha256: sha(data), warnings: [] };
    const complete = await request("POST", `/api/agent/v1/jobs/${jobId}/complete`, {
      token: source.token,
      body: totals,
    });
    expect(complete.status).toBe(202);
    // A `fail` after an accepted `complete` (the agent lost the answer and stopped) changes nothing.
    expect(
      (
        await request("POST", `/api/agent/v1/jobs/${jobId}/fail`, {
          token: source.token,
          body: { message: "The agent was stopped" },
        })
      ).status,
    ).toBe(204);
    // A repeated `complete` (lost answer) is accepted again.
    expect(
      (await request("POST", `/api/agent/v1/jobs/${jobId}/complete`, { token: source.token, body: totals }))
        .status,
    ).toBe(202);

    const run = await eventually(async () => {
      const [row] = await getDb().select().from(runs).where(eq(runs.id, jobId));
      return row && row.status !== "running" ? row : undefined;
    }, 60_000);
    expect(run.status).toBe("succeeded");
    expect(run.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(openUploadCount()).toBe(0);

    const view = await request("GET", `/api/v1/sources/${source.id}`, { userId: admin.id });
    expect(view.body).toMatchObject({
      status: "ok",
      lastSnapshot: { id: run.snapshotId!.slice(0, 8), bytes: data.length },
    });

    const list = await request("GET", `/api/v1/sources/${source.id}/snapshots`, { userId: admin.id });
    expect(list.body.items).toHaveLength(1);
    const download = await request(
      "GET",
      `/api/v1/sources/${source.id}/snapshots/${list.body.items[0].id}/download`,
      {
        userId: admin.id,
      },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="Wiki-.*\.tar"$/);
    expect(sha(download.bytes)).toBe(sha(data));

    const audit = await request("GET", "/api/v1/audit", { userId: admin.id });
    expect(audit.body.items.map((item: { action: string }) => item.action)).toContain("snapshot.download");
  });

  it("saves nothing when the totals do not match, and records the agent's failure", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const source = await appSource(admin.id);
    await request("POST", `/api/v1/sources/${source.id}/run`, { userId: admin.id, body: {} });
    const job = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body.job;
    const data = stream(PART + 10);
    const parts = await upload(source.token, job.id, data);
    const mismatch = await request("POST", `/api/agent/v1/jobs/${job.id}/complete`, {
      token: source.token,
      body: { parts, bytes: data.length + 1, sha256: sha(data), warnings: [] },
    });
    expect(mismatch.status).toBe(422);
    const [failed] = await getDb().select().from(runs).where(eq(runs.id, job.id));
    expect(failed).toMatchObject({ status: "failed", snapshotId: null });
    // The job is over: more parts are refused.
    const late = await request("PUT", `/api/agent/v1/jobs/${job.id}/parts/${parts}`, {
      token: source.token,
      raw: Buffer.from("x"),
      headers: { "x-part-sha256": sha(Buffer.from("x")) },
    });
    expect(late.status).toBe(410);
    expect(
      (await request("GET", `/api/v1/sources/${source.id}/snapshots`, { userId: admin.id })).body.items,
    ).toEqual([]);

    await request("POST", `/api/v1/sources/${source.id}/run`, { userId: admin.id, body: {} });
    const second = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body
      .job;
    const fail = await request("POST", `/api/agent/v1/jobs/${second.id}/fail`, {
      token: source.token,
      body: { message: "pg_dump failed: connection refused" },
    });
    expect(fail.status).toBe(204);
    const [reported] = await getDb().select().from(runs).where(eq(runs.id, second.id));
    expect(reported).toMatchObject({
      status: "failed",
      error: "The agent reported: pg_dump failed: connection refused",
    });
    const view = await request("GET", `/api/v1/sources/${source.id}`, { userId: admin.id });
    expect(view.body.status).toBe("failed");
  });

  it("stops an upload an admin cancels", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const source = await appSource(admin.id);
    await request("POST", `/api/v1/sources/${source.id}/run`, { userId: admin.id, body: {} });
    const job = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body.job;
    await upload(source.token, job.id, stream(PART));
    const cancel = await request("POST", `/api/v1/runs/${job.id}/cancel`, { userId: admin.id, body: {} });
    expect(cancel.status).toBe(200);
    const next = stream(10);
    const refused = await request("PUT", `/api/agent/v1/jobs/${job.id}/parts/1`, {
      token: source.token,
      raw: next,
      headers: { "x-part-sha256": sha(next) },
    });
    expect(refused.status).toBe(410);
    const [cancelled] = await getDb().select().from(runs).where(eq(runs.id, job.id));
    expect(cancelled!.status).toBe("cancelled");
  });

  describe("a restart during an upload", () => {
    async function scheduledJob(adminId: string) {
      await setUpTarget({ id: adminId, email: "ada@example.org" });
      const source = await appSource(adminId);
      const run = await createRun(getDb(), { kind: "backup", sourceId: source.id, trigger: "schedule" });
      const job = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body
        .job;
      expect(job.id).toBe(run.id);
      return { source, jobId: run.id as string };
    }
    const runOf = async (id: string) => (await getDb().select().from(runs).where(eq(runs.id, id)))[0]!;

    it("queues a scheduled backup again when the web process stops, and the agent sends it again", async () => {
      const admin = await createUser();
      const { source, jobId } = await scheduledJob(admin.id);
      await upload(source.token, jobId, stream(PART));

      // A deploy stops the web process: the upload ends, the backup waits for the next process.
      await abortAllUploads();
      expect(openUploadCount()).toBe(0);
      const requeued = await runOf(jobId);
      expect(requeued).toMatchObject({ status: "queued", trigger: "retry", upload: null, error: null });
      expect(requeued.log.join("\n")).toMatch(/The web process stopped during the upload; queued again/);
      const chunk = stream(10);
      const late = await request("PUT", `/api/agent/v1/jobs/${jobId}/parts/1`, {
        token: source.token,
        raw: chunk,
        headers: { "x-part-sha256": sha(chunk) },
      });
      expect(late.status).toBe(410);
      resetStoppingForTests();

      // The agent asks again and sends the whole stream once more.
      const again = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body;
      expect(again.job).toEqual({ id: jobId, partBytes: PART });
      const data = stream(PART + 10);
      const parts = await upload(source.token, jobId, data);
      const complete = await request("POST", `/api/agent/v1/jobs/${jobId}/complete`, {
        token: source.token,
        body: { parts, bytes: data.length, sha256: sha(data), warnings: [] },
      });
      expect(complete.status).toBe(202);
      const done = await eventually(async () => {
        const run = await runOf(jobId);
        return run.status === "running" ? undefined : run;
      }, 60_000);
      expect(done).toMatchObject({ status: "succeeded", trigger: "retry" });
      const list = await request("GET", `/api/v1/sources/${source.id}/snapshots`, { userId: admin.id });
      expect(list.body.items).toHaveLength(1);
    });

    it("queues a backup again only once, and a manual backup never", async () => {
      const admin = await createUser();
      const { source, jobId } = await scheduledJob(admin.id);
      await abortAllUploads();
      resetStoppingForTests();
      expect(await runOf(jobId)).toMatchObject({ status: "queued", trigger: "retry" });

      // The agent restarted while it sent the retry (it asks again with the upload open): that ends it.
      const retry = (await request("POST", "/api/agent/v1/poll", { token: source.token, body: report })).body;
      expect(retry.job.id).toBe(jobId);
      const restarted = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
      expect(restarted.body.job).toBeNull();
      expect(await runOf(jobId)).toMatchObject({
        status: "failed",
        error: "The agent restarted during the upload",
      });

      const manual = await request("POST", `/api/v1/sources/${source.id}/run`, {
        userId: admin.id,
        body: {},
      });
      await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
      await abortAllUploads();
      resetStoppingForTests();
      expect(await runOf(manual.body.id)).toMatchObject({
        status: "failed",
        trigger: "manual",
        error: "The web process stopped during the upload",
      });
    });

    it("queues a scheduled backup again when the agent restarted, and hands it out at once", async () => {
      const admin = await createUser();
      const { source, jobId } = await scheduledJob(admin.id);
      await upload(source.token, jobId, stream(PART));
      // The agent restarted and asks for work while its upload is still open.
      const poll = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
      expect(poll.body.job).toEqual({ id: jobId, partBytes: PART });
      const run = await runOf(jobId);
      expect(run).toMatchObject({ status: "running", trigger: "retry" });
      expect(run.log.join("\n")).toMatch(/The agent restarted during the upload; queued again/);
      await abortAllUploads();
      resetStoppingForTests();
    });

    it("lets no late request of the first attempt end the retry", async () => {
      const admin = await createUser();
      const { source, jobId } = await scheduledJob(admin.id);
      // A `/fail` of the first attempt arrives, then waits (its client gave up after a minute)...
      const arrived = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // ...while the agent asks again and gets the same run as a retry.
      const poll = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
      expect(poll.body.job).toEqual({ id: jobId, partBytes: PART });
      await failJob(getDb(), await getSourceRow(getDb(), source.id), jobId, "pg_dump failed", arrived);
      expect(await runOf(jobId)).toMatchObject({ status: "running", trigger: "retry" });
      const data = stream(PART + 10);
      const parts = await upload(source.token, jobId, data);
      const complete = await request("POST", `/api/agent/v1/jobs/${jobId}/complete`, {
        token: source.token,
        body: { parts, bytes: data.length, sha256: sha(data), warnings: [] },
      });
      expect(complete.status).toBe(202);
      const done = await eventually(async () => {
        const run = await runOf(jobId);
        return run.status === "running" ? undefined : run;
      }, 60_000);
      expect(done).toMatchObject({ status: "succeeded", trigger: "retry" });
    });

    it("lets no late /fail end a retry that is still starting up", async () => {
      const admin = await createUser();
      await setUpTarget({ id: admin.id, email: "ada@example.org" });
      const source = await appSource(admin.id);
      const run = await createRun(getDb(), { kind: "backup", sourceId: source.id, trigger: "schedule" });
      const row = await getSourceRow(getDb(), source.id);
      const arrived = Date.now() - 60_000;
      // Claimed again (running) after the request arrived, its upload not open yet.
      await getDb()
        .update(runs)
        .set({ status: "running", trigger: "retry", startedAt: new Date() })
        .where(eq(runs.id, run.id));
      await failJob(getDb(), row, run.id, "pg_dump failed", arrived);
      expect(await runOf(run.id)).toMatchObject({ status: "running" });
      // A /fail of this attempt still ends it.
      await failJob(getDb(), row, run.id, "pg_dump failed", Date.now());
      expect(await runOf(run.id)).toMatchObject({
        status: "failed",
        error: "The agent reported: pg_dump failed",
      });
    });

    it("queues a scheduled backup again when the agent was stopped (an update of the agent)", async () => {
      const admin = await createUser();
      const { source, jobId } = await scheduledJob(admin.id);
      await upload(source.token, jobId, stream(PART));
      const fail = await request("POST", `/api/agent/v1/jobs/${jobId}/fail`, {
        token: source.token,
        body: { message: "The agent was stopped" },
      });
      expect(fail.status).toBe(204);
      expect(openUploadCount()).toBe(0);
      const run = await runOf(jobId);
      expect(run).toMatchObject({ status: "queued", trigger: "retry", error: null });
      expect(run.log.join("\n")).toMatch(/The agent stopped during the upload; queued again/);
      const poll = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
      expect(poll.body.job.id).toBe(jobId);
      await abortAllUploads();
      resetStoppingForTests();
    });

    it("queues a scheduled backup again that a crashed web process left running", async () => {
      const admin = await createUser();
      await setUpTarget(admin);
      const source = await appSource(admin.id);
      const [orphan] = await getDb()
        .insert(runs)
        .values({
          kind: "backup",
          sourceId: source.id,
          trigger: "schedule",
          status: "running",
          startedAt: new Date(),
          upload: { parts: 3, bytes: 3 * PART, lastActivityAt: new Date().toISOString() },
        })
        .returning();
      await failOrphanedUploads(getDb());
      expect(await runOf(orphan!.id)).toMatchObject({ status: "queued", trigger: "retry", upload: null });
      const poll = await request("POST", "/api/agent/v1/poll", { token: source.token, body: report });
      expect(poll.body.job.id).toBe(orphan!.id);
      await abortAllUploads();
      resetStoppingForTests();
    });
  });
});
