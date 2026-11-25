import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backup/shared/api/schedule";
import { getDb } from "../db/client";
import { runs, sources } from "../db/schema";
import { resetConfigForTests } from "../config";
import { listSnapshots, runRestic, SELF_TAG } from "../restic/restic";
import { openRepository } from "../target/target";
import { createUser, eventually, request, resetDatabase, setUpTarget } from "../test/helpers";
import { claimNextRun, executeNext, failInterruptedRuns, pgEnv } from "./execute";
import { AGENT_PICKUP_MS, expireAgentRuns, planRuns } from "./scheduler";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

describe("the worker", () => {
  beforeAll(async () => {
    // A stand-in for pg_dump: the plumbing (restic --stdin-from-command, libpq's
    // settings in the environment) is what this test checks.
    const directory = await mkdtemp(path.join(os.tmpdir(), "backup-pgdump-"));
    const script = path.join(directory, "pg_dump");
    await writeFile(script, '#!/bin/sh\nprintf "dump of %s as %s\\n" "$PGDATABASE" "$PGUSER"\n');
    await chmod(script, 0o755);
    process.env.PG_DUMP_BINARY = script;
    resetConfigForTests();
  });
  afterAll(() => {
    delete process.env.PG_DUMP_BINARY;
    resetConfigForTests();
  });
  beforeEach(resetDatabase);

  it("plans a backup when its time comes, once", async () => {
    const admin = await createUser();
    const created = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "app",
        name: "Timesheets",
        schedule: { type: "hourly", every: 1, minute: 0 },
        retention: DEFAULT_RETENTION,
      },
    });
    const id = created.body.source.id as string;
    const next = new Date(created.body.source.nextRunAt as string);
    await planRuns(getDb(), new Date(next.getTime() - 1000));
    expect(await getDb().select().from(runs)).toHaveLength(0);
    await planRuns(getDb(), new Date(next.getTime() + 1000));
    await planRuns(getDb(), new Date(next.getTime() + 2000));
    const planned = await getDb().select().from(runs).where(eq(runs.kind, "backup"));
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ sourceId: id, status: "queued", trigger: "schedule" });
    const [source] = await getDb().select().from(sources).where(eq(sources.id, id));
    expect(source!.nextRunAt!.getTime()).toBe(next.getTime() + 3_600_000);

    // The worker never takes an app's job: that is the agent's.
    expect(await claimNextRun(getDb())).toBeNull();
    await expireAgentRuns(getDb(), new Date(Date.now() + AGENT_PICKUP_MS + 60_000));
    const [expired] = await getDb().select().from(runs).where(eq(runs.id, planned[0]!.id));
    expect(expired!.status).toBe("failed");
    expect(expired!.error).toMatch(/did not ask for the job/);
  });

  it("backs up its own database, then runs the upkeep", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const started = await request("POST", "/api/v1/maintenance/run", { userId: admin.id, body: {} });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ kind: "maintenance", status: "queued" });

    expect(await executeNext(getDb())).toBe(true);
    const [self] = await getDb().select().from(runs).where(eq(runs.kind, "self"));
    expect(self).toMatchObject({ status: "succeeded" });
    const repository = await openRepository(getDb());
    const snapshots = await listSnapshots(repository, SELF_TAG);
    expect(snapshots).toHaveLength(1);

    expect(await executeNext(getDb())).toBe(true);
    const [upkeep] = await getDb().select().from(runs).where(eq(runs.kind, "maintenance"));
    expect(upkeep!.error).toBeNull();
    expect(upkeep!.status).toBe("succeeded");
    expect(upkeep!.log.join("\n")).toMatch(/Upkeep done/);
    const target = await request("GET", "/api/v1/target", { userId: admin.id });
    expect(target.body.lastCheck).toMatchObject({ ok: true });
    expect(target.body.stats.snapshots).toBe(1);
    expect(target.body.stats.storedBytes).toBeGreaterThan(0);

    const dashboard = await request("GET", "/api/v1/dashboard", { userId: admin.id });
    expect(dashboard.body.selfBackup).toMatchObject({ status: "succeeded", sourceName: "Backup" });
    expect(dashboard.body.maintenance).toMatchObject({
      status: "succeeded",
      sourceName: "Repository upkeep",
    });
    expect(dashboard.body.attention.map((item: { message: string }) => item.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/recovery kit/)]),
    );
  });

  it("ends a run that was left running, so the next ones start", async () => {
    // As after a database outage at the end of a run: its end was never saved.
    const [stuck] = await getDb()
      .insert(runs)
      .values({ kind: "self", sourceId: null, trigger: "schedule", status: "running", startedAt: new Date() })
      .returning();
    await getDb().insert(runs).values({ kind: "maintenance", sourceId: null, trigger: "schedule" });

    expect(await executeNext(getDb())).toBe(true);
    const [self] = await getDb().select().from(runs).where(eq(runs.id, stuck!.id));
    expect(self).toMatchObject({ status: "failed", error: expect.stringMatching(/could not be saved/) });
    // The upkeep was claimed (it fails here for lack of a target).
    const [upkeep] = await getDb().select().from(runs).where(eq(runs.kind, "maintenance"));
    expect(upkeep!.status).toBe("failed");
    expect(upkeep!.error).toMatch(/Set up the target/);
  });

  it("queues a scheduled run again after a restart, once", async () => {
    const [scheduled] = await getDb()
      .insert(runs)
      .values({ kind: "self", sourceId: null, trigger: "schedule", status: "running", startedAt: new Date() })
      .returning();
    const [manual] = await getDb()
      .insert(runs)
      .values({
        kind: "maintenance",
        sourceId: null,
        trigger: "manual",
        status: "running",
        startedAt: new Date(),
      })
      .returning();
    const [cancelling] = await getDb()
      .insert(runs)
      .values({
        kind: "maintenance",
        sourceId: null,
        trigger: "schedule",
        status: "running",
        startedAt: new Date(),
        cancelRequested: true,
      })
      .returning();

    await failInterruptedRuns(getDb(), "restart");
    const row = async (id: string) => (await getDb().select().from(runs).where(eq(runs.id, id)))[0]!;
    const requeued = await row(scheduled!.id);
    expect(requeued).toMatchObject({ status: "queued", trigger: "retry", startedAt: null, error: null });
    expect(requeued.queuedAt.getTime()).toBeGreaterThan(scheduled!.queuedAt.getTime() - 1);
    expect(requeued.log.join("\n")).toMatch(/The worker restarted during the run; queued again/);
    expect(await row(manual!.id)).toMatchObject({
      status: "failed",
      error: "The worker restarted during the run",
    });
    expect(await row(cancelling!.id)).toMatchObject({ status: "cancelled", error: "Cancelled by an admin" });

    // The retry runs; a second restart during it ends it.
    expect((await claimNextRun(getDb()))!.id).toBe(scheduled!.id);
    await failInterruptedRuns(getDb(), "restart");
    expect(await row(scheduled!.id)).toMatchObject({
      status: "failed",
      trigger: "retry",
      error: "The worker restarted during the run",
    });
  });

  it("stops the run when the worker stops, and queues it again", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    // A pg_dump that takes long: the worker stops while restic reads it. Like a real
    // pg_dump, it writes all the time, so it ends once restic stopped reading.
    const directory = await mkdtemp(path.join(os.tmpdir(), "backup-pgdump-"));
    const slow = path.join(directory, "pg_dump");
    await writeFile(slow, "#!/bin/sh\nwhile :; do echo row; sleep 0.1; done\n");
    await chmod(slow, 0o755);
    const fast = process.env.PG_DUMP_BINARY;
    process.env.PG_DUMP_BINARY = slow;
    resetConfigForTests();
    try {
      const [queued] = await getDb()
        .insert(runs)
        .values({ kind: "self", sourceId: null, trigger: "schedule" })
        .returning();
      const stop = new AbortController();
      const executing = executeNext(getDb(), stop.signal);
      await eventually(async () => {
        const [run] = await getDb().select().from(runs).where(eq(runs.id, queued!.id));
        return run!.log.some((line) => line.endsWith("Dumping this app's database")) ? true : undefined;
      });
      // Give restic a moment to start pg_dump and take its lock.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      stop.abort();
      expect(await executing).toBe(false);
      const [run] = await getDb().select().from(runs).where(eq(runs.id, queued!.id));
      expect(run).toMatchObject({ status: "queued", trigger: "retry", error: null });
      expect(run!.log.join("\n")).toMatch(/The worker stopped during the run; queued again/);
      // restic stopped cleanly: it left no lock that would hold back the next run.
      const locks = await runRestic(await openRepository(getDb()), ["list", "locks", "--no-lock"]);
      expect(locks.stdout.trim()).toBe("");
      // A stopped worker claims nothing more.
      expect(await executeNext(getDb(), stop.signal)).toBe(false);
    } finally {
      process.env.PG_DUMP_BINARY = fast;
      resetConfigForTests();
    }
  });

  it("passes the database settings to pg_dump in the environment, decoded", () => {
    expect(pgEnv("postgres://back%40ups:p%40ss%3Aword@db.example.org:6543/my_db?sslmode=require")).toEqual({
      PGHOST: "db.example.org",
      PGPORT: "6543",
      PGUSER: "back@ups",
      PGPASSWORD: "p@ss:word",
      PGDATABASE: "my_db",
      PGSSLMODE: "require",
    });
  });
});
