import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backup/shared/api/schedule";
import { getDb } from "../db/client";
import { backupDirectory, listSnapshots, sourceTag } from "../restic/restic";
import { openRepository } from "../target/target";
import { forgetDeletedSources } from "../worker/maintenance";
import { createUser, request, resetDatabase, setUpTarget, testApp } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

const schedule = { type: "daily", time: "02:00" };
const KEY = JSON.stringify({
  type: "service_account",
  client_email: "backup@example-project.iam.gserviceaccount.com",
  client_id: "1234567890",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
});

describe("sources", () => {
  beforeEach(resetDatabase);

  it("checks each kind's settings and never answers with secrets", async () => {
    const admin = await createUser();
    const badKey = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "google_drive",
        name: "Shared drive",
        schedule,
        retention: DEFAULT_RETENTION,
        config: {
          subject: "backup@example.org",
          scope: { type: "shared_drive", driveId: "0ABCdefGHIjklMNOpq" },
        },
        secrets: { serviceAccountKey: "{}" },
      },
    });
    expect(badKey.status).toBe(422);
    expect(badKey.body.error.fields).toHaveProperty(["secrets.serviceAccountKey"]);

    const drive = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "google_drive",
        name: "Shared drive",
        schedule,
        retention: DEFAULT_RETENTION,
        config: {
          subject: "backup@example.org",
          scope: { type: "shared_drive", driveId: "0ABCdefGHIjklMNOpq" },
        },
        secrets: { serviceAccountKey: KEY },
      },
    });
    expect(drive.status).toBe(201);
    expect(drive.body.token).toBeNull();
    expect(drive.body.source.config).toMatchObject({
      serviceAccountEmail: "backup@example-project.iam.gserviceaccount.com",
      serviceAccountClientId: "1234567890",
    });
    expect(JSON.stringify(drive.body)).not.toContain("PRIVATE KEY");
    expect(drive.body.source).toMatchObject({ status: "never", enabled: true });
    expect(drive.body.source.nextRunAt).not.toBeNull();

    const noSecret = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "personio",
        name: "People",
        schedule,
        retention: DEFAULT_RETENTION,
        config: { clientId: "papi-client" },
      },
    });
    expect(noSecret.status).toBe(422);
    expect(noSecret.body.error.fields).toHaveProperty(["secrets.clientSecret"]);

    const personio = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "personio",
        name: "People",
        schedule,
        retention: DEFAULT_RETENTION,
        config: { clientId: "papi-client" },
        secrets: { clientSecret: "papi-secret-1234" },
      },
    });
    expect(personio.body.source.config).toEqual({
      baseUrl: "https://api.personio.de",
      clientId: "papi-client",
      documents: true,
      clientSecretHint: "…1234",
    });
    // A change without the secret keeps it; pausing clears the next run.
    const paused = await request("PUT", `/api/v1/sources/${personio.body.source.id}`, {
      userId: admin.id,
      body: {
        kind: "personio",
        name: "People (HR)",
        enabled: false,
        schedule: { type: "weekly", day: 1, time: "03:15" },
        retention: { daily: 7, weekly: 4, monthly: 6, yearly: 1 },
        config: { clientId: "papi-client", documents: false },
        secrets: { clientSecret: "" },
      },
    });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({
      name: "People (HR)",
      status: "paused",
      nextRunAt: null,
      config: { documents: false, clientSecretHint: "…1234" },
    });
    const kindChange = await request("PUT", `/api/v1/sources/${personio.body.source.id}`, {
      userId: admin.id,
      body: { kind: "app", name: "X", schedule, retention: DEFAULT_RETENTION },
    });
    expect(kindChange.status).toBe(422);
  });

  it("replaces an agent token: the old one stops working", async () => {
    const admin = await createUser();
    const created = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: { kind: "app", name: "Tickets", schedule, retention: DEFAULT_RETENTION },
    });
    const old = created.body.token as string;
    expect(old).toMatch(/^bkp_[A-Za-z0-9_-]{43}$/);
    expect(created.body.source.agent).toMatchObject({ lastSeenAt: null, tokenHint: `…${old.slice(-4)}` });
    const poll = {
      agent: { version: "0.1.0" },
      app: { name: "tickets", image: "" },
      database: true,
      volumes: [],
    };
    expect((await request("POST", "/api/agent/v1/poll", { token: old, body: poll })).status).toBe(200);
    const rotated = await request("POST", `/api/v1/sources/${created.body.source.id}/token`, {
      userId: admin.id,
      body: {},
    });
    expect((await request("POST", "/api/agent/v1/poll", { token: old, body: poll })).status).toBe(401);
    expect(
      (await request("POST", "/api/agent/v1/poll", { token: rotated.body.token, body: poll })).status,
    ).toBe(200);
  });

  it("deletes a source and, when asked, forgets its snapshots", async () => {
    const admin = await createUser();
    await setUpTarget(admin);
    const keep = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: { kind: "app", name: "Keep", schedule, retention: DEFAULT_RETENTION },
    });
    const forget = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: { kind: "app", name: "Forget", schedule, retention: DEFAULT_RETENTION },
    });
    const repository = await openRepository(getDb());
    const directory = await mkdtemp(path.join(os.tmpdir(), "backups-source-"));
    await writeFile(path.join(directory, "a.txt"), "hello");
    for (const id of [keep.body.source.id, forget.body.source.id]) {
      await backupDirectory(repository, { tag: sourceTag(id), directory });
    }
    // That snapshot holds no backup.tar (it is a folder): restic dump fails, and so does the download.
    const [snapshot] = await listSnapshots(repository, sourceTag(keep.body.source.id));
    const response = await testApp().request(
      `/api/v1/sources/${keep.body.source.id}/snapshots/${snapshot!.shortId}/download`,
      { headers: { "x-test-user": admin.id } },
    );
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(
      (await request("DELETE", `/api/v1/sources/${keep.body.source.id}?snapshots=keep`, { userId: admin.id }))
        .status,
    ).toBe(204);
    expect(
      (
        await request("DELETE", `/api/v1/sources/${forget.body.source.id}?snapshots=forget`, {
          userId: admin.id,
        })
      ).status,
    ).toBe(204);
    expect(await listSnapshots(repository, sourceTag(keep.body.source.id))).toHaveLength(1);
    // The next upkeep forgets them.
    expect(await listSnapshots(repository, sourceTag(forget.body.source.id))).toHaveLength(1);
    expect(await forgetDeletedSources(getDb(), repository)).toEqual([]);
    expect(await listSnapshots(repository, sourceTag(forget.body.source.id))).toHaveLength(0);
    expect(await listSnapshots(repository, sourceTag(keep.body.source.id))).toHaveLength(1);
    expect((await request("GET", "/api/v1/sources", { userId: admin.id })).body.items).toEqual([]);
  });
});
