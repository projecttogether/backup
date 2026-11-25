import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backup/shared/api/schedule";
import { resetConfigForTests } from "../config";
import { closeDb, getDb } from "../db/client";
import { auditLog, runs, settings, sources } from "../db/schema";
import { logger } from "../logger";
import { SERVER_ROOT } from "../paths";
import { createUser, request, resetDatabase, TEST_S3 } from "../test/helpers";
import { runCli } from "./main";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/** Mailpit of compose.dev.yaml (CI starts the same). */
const MAILPIT = process.env.TEST_MAILPIT_URL ?? "http://localhost:8125";
const SMTP_PORT = Number(process.env.TEST_SMTP_PORT ?? 1035);

const SMTP_PASSWORD = "smtp-password-7f3a";
const PERSONIO_SECRET = "personio-secret-2c9e";
/** The heartbeat URL's path authorizes the pings: the command shows only a hint of it. */
const HEARTBEAT_PATH = "ping/c0ffee-secret-path";
const SECRETS = [TEST_S3.secretAccessKey, SMTP_PASSWORD, PERSONIO_SECRET, HEARTBEAT_PATH];

/** Everything the command printed in this test, and every log call. */
let printed: string[];

/** Runs `cli <args>` with `stdin` (a JSON value, or text as is). */
async function cli(args: string[], stdin?: unknown, options: { terminal?: boolean; keep?: boolean } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    readStdin: async () =>
      typeof stdin === "string" ? stdin : stdin === undefined ? "" : JSON.stringify(stdin),
    out: (text) => void (stdout += text),
    err: (text) => void (stderr += text),
    stdoutIsTerminal: options.terminal ?? false,
  });
  // `keep: false`: stdout is meant to hold a secret (the recovery kit); it is not checked.
  printed.push(options.keep === false ? "" : stdout, stderr);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, unknown> };
}

async function auditEntries(action: string) {
  return getDb().select().from(auditLog).where(eq(auditLog.action, action));
}

async function stored(key: string) {
  const [row] = await getDb().select().from(settings).where(eq(settings.key, key));
  return row?.value;
}

const prefix = () => `test/cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const targetBody = (folder: string) => ({
  endpoint: TEST_S3.endpoint,
  region: TEST_S3.region,
  bucket: TEST_S3.bucket,
  prefix: folder,
  accessKeyId: TEST_S3.accessKeyId,
  secretAccessKey: TEST_S3.secretAccessKey,
});

const SCHEDULE = { type: "daily", time: "02:00" } as const;

beforeEach(async () => {
  await resetDatabase();
  printed = [];
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      printed.push(JSON.stringify(args));
    });
  }
});

afterEach(() => {
  // No secret in any output, message or log line of the test.
  for (const text of printed) for (const secret of SECRETS) expect(text).not.toContain(secret);
  vi.restoreAllMocks();
});

describe("cli settings list", () => {
  it("names every setting and source, set or not, with hints only", async () => {
    const empty = await cli(["settings", "list"]);
    expect(empty).toMatchObject({ code: 0, stderr: "" });
    expect(empty.stdout).toBe(
      "target         not set\n" +
        "maintenance    not set     daily at 04:30 (the default), UTC\n" +
        "sources        not set     no sources\n" +
        "notifications  not set\n",
    );
    const asJson = await cli(["settings", "list", "--json"]);
    expect(JSON.parse(asJson.stdout)).toEqual([
      { name: "target", state: "not set", hints: [] },
      { name: "maintenance", state: "not set", hints: ["daily at 04:30 (the default), UTC"] },
      { name: "sources", state: "not set", hints: ["no sources"] },
      { name: "notifications", state: "not set", hints: [] },
    ]);
  });
});

describe("cli settings … target, and cli target …", () => {
  it("saves the bucket, creates the repository, writes and confirms the recovery kit", async () => {
    const folder = prefix();
    const { secretAccessKey: _secret, ...withoutSecret } = targetBody(folder);
    // The page's first save needs the secret key.
    expect(await cli(["settings", "apply", "target"], withoutSecret)).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Check the highlighted fields\n  secretAccessKey: Enter the secret key\n",
    });
    expect(await stored("target")).toBeUndefined();

    const applied = await cli(["settings", "apply", "target"], targetBody(folder));
    expect(applied).toMatchObject({ code: 0, stderr: "" });
    const url = `s3:${TEST_S3.endpoint}/${TEST_S3.bucket}/${folder}`;
    expect(applied.json()).toMatchObject({
      configured: true,
      repositoryUrl: url,
      secretAccessKeyHint: "…cret",
      repository: { state: "unknown", hasPassword: false },
    });
    expect(JSON.stringify(await stored("target"))).toMatch(/"secretAccessKey":"v1:/);
    expect((await cli(["settings", "show", "target"])).stdout).toBe(applied.stdout);
    expect((await cli(["settings", "list"])).stdout).toContain(
      `target         incomplete  ${url}; access key ${TEST_S3.accessKeyId}; secret key …cret; no repository yet\n`,
    );
    expect((await auditEntries("target.update"))[0]).toMatchObject({
      actorId: null,
      actorEmail: "operator",
      summary: `Set the target to ${url} (cli settings apply target)`,
    });

    // The test button: the bucket answers, there is no repository yet.
    const tested = await cli(["settings", "test", "target"]);
    expect(tested.code).toBe(0);
    expect(tested.json()).toMatchObject({ repository: { state: "missing" } });
    expect(tested.stderr).toContain("There is no repository at this address yet.");

    const created = await cli(["target", "initialize"]);
    expect(created).toMatchObject({ code: 0 });
    expect(created.json()).toMatchObject({ repository: { state: "ready", hasPassword: true } });
    expect(created.stderr).toContain("(umask 077; set -C; cli target recovery-kit > recovery-kit.txt)");
    expect((await auditEntries("repository.create"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: `Created the repository at ${url} (cli target initialize)`,
    });
    expect(await cli(["settings", "test", "target"])).toMatchObject({
      code: 0,
      stderr: "The repository is ready. Backups go here.\n",
    });
    expect(await cli(["target", "initialize"])).toMatchObject({
      code: 1,
      stderr: "The repository exists already\n",
    });

    // Never onto a screen; into a file (a pipe) it is the page's download.
    expect(await cli(["target", "recovery-kit"], undefined, { terminal: true })).toMatchObject({
      code: 2,
      stdout: "",
      stderr: expect.stringContaining("redirect it into a file"),
    });
    expect(await auditEntries("recovery_kit.download")).toHaveLength(0);
    const kit = await cli(["target", "recovery-kit"], undefined, { keep: false });
    expect(kit.code).toBe(0);
    expect(kit.stdout).toContain(`RESTIC_REPOSITORY=${url}`);
    expect(kit.stdout).toContain(`AWS_SECRET_ACCESS_KEY=${TEST_S3.secretAccessKey}`);
    expect((await auditEntries("recovery_kit.download"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: "Downloaded the recovery kit (cli target recovery-kit)",
    });
    const password = /RESTIC_PASSWORD=(.+)/.exec(kit.stdout)![1]!;

    const confirmed = await cli(["target", "confirm-recovery-kit"]);
    expect(confirmed.code).toBe(0);
    expect(confirmed.json().recoveryKitConfirmedAt).toEqual(expect.any(String));
    expect((await cli(["settings", "list"])).stdout).toContain("repository ready; recovery kit stored\n");

    // Connecting needs the repository's password, as on the page.
    expect(await cli(["target", "connect"], { password: "not-the-password" })).toMatchObject({
      code: 1,
      stderr: "Check the highlighted fields\n  password: This password does not open the repository\n",
    });
    const connected = await cli(["target", "connect"], { password }, { keep: false });
    expect(connected).toMatchObject({ code: 0, stderr: "Connected the repository.\n" });
    expect(connected.stdout).not.toContain(password);
    expect((await auditEntries("repository.connect"))[0]).toMatchObject({ actorEmail: "operator" });
    expect(await cli(["target", "connect"], "password")).toMatchObject({ code: 2 });
  });

  it("reports a bucket that refuses the keys as a failed test", async () => {
    await cli(["settings", "apply", "target"], {
      ...targetBody(prefix()),
      secretAccessKey: "not-the-secret-key-9b1d",
    });
    const tested = await cli(["settings", "test", "target"]);
    expect(tested.code).toBe(1);
    expect(tested.json()).toMatchObject({ repository: { state: "error" } });
    expect(tested.stderr).toBe(
      `${(tested.json() as { repository: { message: string } }).repository.message}\n`,
    );
    expect(tested.stderr).not.toContain("not-the-secret-key-9b1d");
  });
});

describe("cli target initialize, with a pool of one connection", () => {
  it("creates the repository: the lock has a connection of its own", async () => {
    await cli(["settings", "apply", "target"], targetBody(prefix()));
    await closeDb();
    process.env.DATABASE_POOL_SIZE = "1";
    resetConfigForTests();
    try {
      const created = await cli(["target", "initialize"]);
      expect(created).toMatchObject({ code: 0 });
      expect(created.json()).toMatchObject({ repository: { state: "ready" } });
    } finally {
      await closeDb();
      delete process.env.DATABASE_POOL_SIZE;
      resetConfigForTests();
    }
  });
});

describe("the audit log", () => {
  it("keeps the operator's command after a long summary", async () => {
    const endpoint = `${TEST_S3.endpoint}/${"a".repeat(480)}`;
    expect((await cli(["settings", "apply", "target"], { ...targetBody(prefix()), endpoint })).code).toBe(0);
    const [entry] = await auditEntries("target.update");
    expect(entry!.summary).toHaveLength(500);
    expect(entry!.summary.endsWith(" (cli settings apply target)")).toBe(true);
  });
});

describe("cli settings … maintenance", () => {
  it("sets the time of the daily upkeep", async () => {
    expect((await cli(["settings", "show", "maintenance"])).json()).toEqual({
      maintenanceTime: "04:30",
      timezone: "UTC",
    });
    expect(await cli(["settings", "apply", "maintenance"], { maintenanceTime: "25:00" })).toMatchObject({
      code: 1,
      stderr: "Check the highlighted fields\n  maintenanceTime: Use HH:MM, e.g. 02:30\n",
    });
    const applied = await cli(["settings", "apply", "maintenance"], { maintenanceTime: "03:15" });
    expect(applied.json()).toEqual({ maintenanceTime: "03:15", timezone: "UTC" });
    expect((await cli(["settings", "list"])).stdout).toContain(
      "maintenance    set         daily at 03:15, UTC\n",
    );
    expect((await auditEntries("maintenance.update"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: "Set the daily upkeep to 03:15 (cli settings apply maintenance)",
    });
    expect((await cli(["settings", "test", "maintenance"])).code).toBe(2);
  });
});

describe("cli settings … notifications", () => {
  const email = {
    enabled: true,
    host: "localhost",
    port: SMTP_PORT,
    security: "none",
    username: "",
    from: "backups@example.org",
    recipients: ["it@example.org"],
  };

  it("saves the alerts, keeps the password write-only and sends the tests", async () => {
    const applied = await cli(["settings", "apply", "notifications"], {
      email: { ...email, username: "backups", password: SMTP_PASSWORD },
      heartbeatUrl: "",
      notifyRecovery: true,
    });
    expect(applied).toMatchObject({ code: 0, stderr: "" });
    expect(applied.json()).toMatchObject({
      email: { passwordHint: "…7f3a", recipients: ["it@example.org"] },
    });
    expect(JSON.stringify(await stored("notifications"))).toMatch(/"password":"v1:/);
    expect((await cli(["settings", "show", "notifications"])).stdout).toBe(applied.stdout);
    expect((await cli(["settings", "list"])).stdout).toContain(
      "notifications  set         email on; server localhost:" +
        `${SMTP_PORT}; from backups@example.org; 1 recipient; password …7f3a; no heartbeat\n`,
    );
    expect((await auditEntries("notifications.update"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: "Changed the alerts (cli settings apply notifications)",
    });
    // An omitted password keeps the saved one, as on the page.
    const again = await cli(["settings", "apply", "notifications"], {
      email: { ...email, username: "backups" },
      heartbeatUrl: "",
      notifyRecovery: false,
    });
    expect(again.json()).toMatchObject({ notifyRecovery: false, email: { passwordHint: "…7f3a" } });

    expect(
      await cli(["settings", "apply", "notifications"], {
        email: { ...email, recipients: ["nobody"] },
        heartbeatUrl: "",
        notifyRecovery: true,
      }),
    ).toMatchObject({
      code: 1,
      stderr: "Check the highlighted fields\n  email.recipients.0: Enter email addresses\n",
    });

    // Mailpit takes mail without credentials.
    await cli(["settings", "apply", "notifications"], { email, heartbeatUrl: "", notifyRecovery: true });
    await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
    const sent = await cli(["settings", "test", "notifications", "--email"]);
    expect(sent).toMatchObject({ code: 0, stderr: "" });
    expect(sent.json()).toEqual({ ok: true, message: "Sent. Check the recipients' inboxes." });
    const mails = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as {
      messages: { Subject: string; Snippet: string }[];
    };
    expect(mails.messages[0]).toMatchObject({ Subject: "[Backup] Test email" });
    expect(mails.messages[0]!.Snippet).toContain("The operator command (cli settings test notifications)");

    await cli(["settings", "apply", "notifications"], {
      email: { ...email, port: 1 },
      heartbeatUrl: "",
      notifyRecovery: true,
    });
    const failed = await cli(["settings", "test", "notifications", "--email"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe(`${(failed.json() as { message: string }).message}\n`);

    expect(await cli(["settings", "test", "notifications"])).toMatchObject({ code: 2 });
    expect(await cli(["settings", "test", "notifications", "--email", "--heartbeat"])).toMatchObject({
      code: 2,
    });
  });

  it("keeps the heartbeat URL write-only, as a secret, and calls it", async () => {
    const calls: string[] = [];
    const server = createServer((incoming, response) => {
      calls.push(incoming.url ?? "");
      response.end("ok");
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await cli(["settings", "test", "notifications", "--heartbeat"])).toMatchObject({
        code: 1,
        stderr: "Set a heartbeat URL first\n",
      });
      const applied = await cli(["settings", "apply", "notifications"], {
        email: { ...email, enabled: false },
        heartbeatUrl: `http://${address}/${HEARTBEAT_PATH}`,
        notifyRecovery: true,
      });
      expect(applied.json()).toMatchObject({ heartbeatUrlHint: `http://${address}/…` });
      expect(applied.json()).not.toHaveProperty("heartbeatUrl");
      expect((await cli(["settings", "show", "notifications"])).stdout).toBe(applied.stdout);
      expect((await cli(["settings", "list"])).stdout).toContain(`email off; server localhost:${SMTP_PORT}`);
      expect((await cli(["settings", "list"])).stdout).toContain(`heartbeat http://${address}/…\n`);
      expect(JSON.stringify(await stored("notifications"))).toMatch(/"heartbeatUrl":"v1:/);

      // Left out of the body, the saved URL stays; "" turns the heartbeat off.
      await cli(["settings", "apply", "notifications"], { email, notifyRecovery: false });
      const tested = await cli(["settings", "test", "notifications", "--heartbeat"]);
      expect(tested).toMatchObject({ code: 0, stderr: "" });
      expect(tested.json()).toEqual({ ok: true, message: "The heartbeat URL answered" });
      expect(calls).toEqual([`/${HEARTBEAT_PATH}`]);
      const off = await cli(["settings", "apply", "notifications"], {
        email,
        heartbeatUrl: "",
        notifyRecovery: true,
      });
      expect(off.json()).toMatchObject({ heartbeatUrlHint: null });
      expect((await cli(["settings", "list"])).stdout).toContain("no heartbeat\n");
    } finally {
      server.close();
    }
  });
});

describe("cli settings … sources", () => {
  const s3Source = (folder: string) => ({
    kind: "s3_bucket",
    name: "Media files",
    schedule: SCHEDULE,
    retention: DEFAULT_RETENTION,
    config: {
      endpoint: TEST_S3.endpoint,
      region: TEST_S3.region,
      bucket: TEST_S3.bucket,
      prefix: folder,
      accessKeyId: TEST_S3.accessKeyId,
    },
    secrets: { secretAccessKey: TEST_S3.secretAccessKey },
  });

  it("adds, shows, changes, tests and removes a source", async () => {
    const folder = prefix();
    const { secrets: _secrets, ...withoutSecret } = s3Source(folder);
    expect(await cli(["settings", "apply", "sources"], withoutSecret)).toMatchObject({
      code: 1,
      stderr: "Check the highlighted fields\n  secrets.secretAccessKey: Enter the secret key\n",
    });
    expect(await getDb().select().from(sources)).toHaveLength(0);

    const added = await cli(["settings", "apply", "sources"], s3Source(folder));
    expect(added.code).toBe(0);
    const id = added.json().id as string;
    expect(added.stderr).toBe(`Added the source Media files. ID: ${id}\n`);
    expect(added.json()).toMatchObject({
      kind: "s3_bucket",
      name: "Media files",
      config: { prefix: folder, secretAccessKeyHint: "…cret" },
    });
    const [row] = await getDb().select().from(sources).where(eq(sources.id, id));
    expect(row!.secrets.secretAccessKey).toMatch(/^v1:/);
    expect((await cli(["settings", "show", "sources", "--id", id])).stdout).toBe(added.stdout);
    expect((await cli(["settings", "show", "sources"])).json()).toEqual({ items: [added.json()] });
    expect((await cli(["settings", "list"])).stdout).toContain(
      `sources --id ${id}  set         S3 bucket "Media files"; daily at 02:00; status never; ` +
        `${TEST_S3.endpoint}/${TEST_S3.bucket}/${folder}; access key ${TEST_S3.accessKeyId}; secret key …cret\n`,
    );
    expect((await auditEntries("source.create"))[0]).toMatchObject({
      entityId: id,
      actorEmail: "operator",
      summary: "Added the source Media files (cli settings apply sources)",
    });

    // An omitted secret keeps the saved one; the kind cannot change, as on the page.
    const { secrets: _kept, ...change } = { ...s3Source(folder), name: "Media", enabled: false };
    const changed = await cli(["settings", "apply", "sources", "--id", id], change);
    expect(changed.json()).toMatchObject({
      name: "Media",
      enabled: false,
      config: { secretAccessKeyHint: "…cret" },
    });
    expect((await auditEntries("source.update"))[0]).toMatchObject({
      summary: `Paused the source Media (cli settings apply sources --id ${id})`,
    });
    expect(
      await cli(["settings", "apply", "sources", "--id", id], {
        kind: "app",
        name: "Media",
        schedule: SCHEDULE,
        retention: DEFAULT_RETENTION,
      }),
    ).toMatchObject({
      code: 1,
      stderr: "Check the highlighted fields\n  kind: The kind of a source cannot change\n",
    });

    // The test button: rclone lists the folder (empty here).
    const tested = await cli(["settings", "test", "sources", "--id", id]);
    expect(tested).toMatchObject({ code: 0, stderr: "" });
    expect(tested.json()).toMatchObject({ ok: true, items: 0 });

    expect((await cli(["settings", "remove", "sources"])).code).toBe(2);
    expect((await cli(["settings", "test", "sources"])).code).toBe(2);
    expect(await cli(["settings", "remove", "sources", "--id", id, "--snapshots", "later"])).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("  snapshots: "),
    });
    const removed = await cli(["settings", "remove", "sources", "--id", id]);
    expect(removed).toMatchObject({
      code: 0,
      stdout: "",
      stderr: "Deleted the source Media; its snapshots stay in the repository.\n",
    });
    expect((await auditEntries("source.delete"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: `Deleted the source Media; its snapshots stay in the repository (cli settings remove sources --id ${id})`,
    });
    expect(await cli(["settings", "show", "sources", "--id", id])).toMatchObject({
      code: 1,
      stderr: "No such source\n",
    });
  });

  it("encrypts a Personio client secret and shows its hint", async () => {
    const added = await cli(["settings", "apply", "sources"], {
      kind: "personio",
      name: "People",
      schedule: SCHEDULE,
      retention: DEFAULT_RETENTION,
      config: { clientId: "papi-client" },
      secrets: { clientSecret: PERSONIO_SECRET },
    });
    expect(added.json()).toMatchObject({ config: { clientId: "papi-client", clientSecretHint: "…2c9e" } });
    const [row] = await getDb().select().from(sources);
    expect(row!.secrets.clientSecret).toMatch(/^v1:/);
    expect((await cli(["settings", "list"])).stdout).toContain("client papi-client; secret …2c9e\n");
  });

  it("prints an app source's .env lines once, and issues new agent tokens", async () => {
    const added = await cli(["settings", "apply", "sources"], {
      kind: "app",
      name: "Wiki",
      schedule: SCHEDULE,
      retention: DEFAULT_RETENTION,
    });
    expect(added.code).toBe(0);
    const [, token] = /^BACKUP_URL=http:\/\/localhost:3000\nBACKUP_TOKEN=(bkp_\S+)\n$/.exec(added.stdout)!;
    const [row] = await getDb().select().from(sources);
    expect(added.stderr).toBe(
      `Added the source Wiki. ID: ${row!.id}\n` +
        "The two lines go into the .env of the app's server; the token is not shown again.\n",
    );
    expect(row!.agentTokenHash).not.toContain(token!);
    expect(JSON.stringify((await cli(["settings", "show", "sources"])).json())).not.toContain(token!);
    expect((await cli(["settings", "list"])).stdout).toContain(
      `sources --id ${row!.id}  incomplete  App (backup agent) "Wiki"; daily at 02:00; status never; ` +
        `token ${row!.agentTokenHint}; agent not seen yet\n`,
    );
    const poll = (bearer: string) =>
      request("POST", "/api/agent/v1/poll", {
        token: bearer,
        body: { agent: { version: "0.1.0" }, app: { name: "wiki" }, database: true, volumes: [] },
      });
    expect((await poll(token!)).status).toBe(200);
    expect((await cli(["settings", "test", "sources", "--id", row!.id])).json()).toMatchObject({ ok: true });

    const issued = await cli(["tokens", "create", "agent", "--source", row!.id]);
    expect(issued.code).toBe(0);
    expect(issued.stdout).toMatch(/^bkp_\S+\n$/);
    expect(issued.stderr).toContain("Issued a new agent token for Wiki; the old one stops working now.");
    expect(issued.stderr).toContain("BACKUP_URL=http://localhost:3000");
    expect((await poll(token!)).status).toBe(401);
    expect((await poll(issued.stdout.trim())).status).toBe(200);
    expect((await auditEntries("source.token"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: `Issued a new agent token for Wiki (cli tokens create agent --source ${row!.id})`,
    });

    const s3 = await cli(["settings", "apply", "sources"], s3Source(prefix()));
    expect(await cli(["tokens", "create", "agent", "--source", s3.json().id as string])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "Check the highlighted fields\n  kind: Only app sources have an agent token\n",
    });
    expect((await cli(["tokens", "create", "agent"])).code).toBe(2);
    expect((await cli(["tokens", "create", "api-key", "--source", row!.id])).code).toBe(2);
  });

  it("starts a backup now, as the page's button does", async () => {
    const added = await cli(["settings", "apply", "sources"], {
      kind: "app",
      name: "Wiki",
      schedule: SCHEDULE,
      retention: DEFAULT_RETENTION,
    });
    const [row] = await getDb().select().from(sources);
    expect(added.code).toBe(0);
    expect(await cli(["sources", "run", row!.id])).toMatchObject({
      code: 1,
      stderr: "Set up the target and its repository first\n",
    });
    // A target with a repository password (the run only waits for the agent).
    await getDb()
      .insert(settings)
      .values({
        key: "target",
        value: {
          ...targetBody(prefix()),
          secretAccessKey: (await import("../core/crypto")).encryptSecret(TEST_S3.secretAccessKey),
          password: (await import("../core/crypto")).encryptSecret("repository-password"),
          repository: { state: "ready", message: null, checkedAt: null },
          recoveryKitConfirmedAt: null,
          protection: null,
        },
      });
    const started = await cli(["sources", "run", row!.id]);
    expect(started.code).toBe(0);
    expect(started.json()).toMatchObject({ kind: "backup", status: "queued", trigger: "manual" });
    expect(started.stderr).toBe(`Queued a backup of Wiki. Run ID: ${started.json().id as string}\n`);
    expect(await getDb().select().from(runs)).toHaveLength(1);
    expect((await auditEntries("source.run"))[0]).toMatchObject({
      actorEmail: "operator",
      summary: `Started a backup of Wiki (cli sources run ${row!.id})`,
    });
    const again = await cli(["sources", "run", row!.id]);
    expect(again.stderr).toBe(`A backup of Wiki is queued already. Run ID: ${started.json().id as string}\n`);
    expect(await getDb().select().from(runs)).toHaveLength(1);
  });
});

describe("cli usage", () => {
  it("prints help with the commands and setting names", async () => {
    const help = await cli(["help"]);
    expect(help.code).toBe(0);
    for (const text of [
      "cli settings list",
      "cli settings apply <name>",
      "cli settings remove sources --id <id>",
      "cli target recovery-kit",
      "cli tokens create agent --source <id>",
      "target",
      "maintenance",
      "sources",
      "notifications",
      "deployment.md",
    ]) {
      expect(help.stdout).toContain(text);
    }
    expect(await cli([])).toMatchObject({ code: 2, stdout: "", stderr: help.stdout });
  });

  it("answers 2 for wrong commands and never repeats what was typed", async () => {
    const secret = TEST_S3.secretAccessKey;
    const wrong = [
      ["tokens", "revoke", "x"],
      ["settings", "rename", "target"],
      ["settings", "show"],
      ["settings", "show", "bucket"],
      ["settings", "show", "target", "--id", "1"],
      ["settings", "show", "sources", "--id", secret],
      ["settings", "remove", "target", "--id", "1"],
      ["settings", "apply", "target", secret],
      ["settings", "apply", "target", `--secretAccessKey=${secret}`],
      ["settings", "apply", "target", `-${secret}`],
      ["settings", "list", "--json=yes"],
      ["target", secret],
      ["target", "connect", secret],
      ["target", "connect", `--password=${secret}`],
      ["sources", "run", secret],
      ["tokens", "create", "agent", "--source", secret],
      ["help", "settings"],
      ["--help", `--token=${secret}`],
    ];
    for (const args of wrong) {
      const result = await cli(args);
      expect({ args, code: result.code, stdout: result.stdout }).toEqual({ args, code: 2, stdout: "" });
      expect(result.stderr).toContain('Run "cli help" for the commands.');
    }
    expect(await cli(["settings", "apply", "target"], "endpoint=https://example.org")).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("The body on stdin is not JSON."),
    });
    expect(await cli(["settings", "apply", "target"], "")).toMatchObject({ code: 2 });
    expect(await stored("target")).toBeUndefined();
  });
});

describe("the admin pages and the command", () => {
  it("run the same code: the page saves as the signed-in admin", async () => {
    const admin = await createUser({ email: "ada@example.org" });
    const saved = await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: {
        email: {
          enabled: false,
          host: "mail.example.org",
          port: 587,
          security: "starttls",
          username: "backups",
          password: SMTP_PASSWORD,
          from: "backups@example.org",
          recipients: [],
        },
        heartbeatUrl: "",
        notifyRecovery: true,
      },
    });
    expect(saved.status).toBe(200);
    const { heartbeatUrl: _none, ...page } = saved.body as Record<string, unknown>;
    expect((await cli(["settings", "show", "notifications"])).json()).toEqual({
      ...page,
      heartbeatUrlHint: null,
    });
    expect((await auditEntries("notifications.update"))[0]).toMatchObject({
      actorId: admin.id,
      actorEmail: "ada@example.org",
      summary: "Changed the alerts",
    });
    const maintenance = await request("PUT", "/api/v1/target/maintenance", {
      userId: admin.id,
      body: { maintenanceTime: "25:00" },
    });
    expect(maintenance.body.error).toEqual({
      code: "validation_error",
      message: "Check the highlighted fields",
      fields: { maintenanceTime: "Use HH:MM, e.g. 02:30" },
    });
  });
});

/** Runs the command in a process of its own, as the image does. `readAfterMs`: a reader that starts late. */
function runProcess(
  args: string[],
  options: { stdin?: string; env?: Record<string, string>; readAfterMs?: number } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(SERVER_ROOT, "src/cli.ts"), ...args],
      {
        cwd: SERVER_ROOT,
        env: { ...process.env, LOG_LEVEL: "debug", ...options.env },
        timeout: 20_000,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    if (options.readAfterMs) {
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), options.readAfterMs);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      printed.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.stdin ?? "");
  });
}

describe("the cli process", () => {
  it("reads the body from stdin, keeps stdout for its output, logs to stderr and exits", async () => {
    const applied = await runProcess(["settings", "apply", "maintenance"], {
      stdin: JSON.stringify({ maintenanceTime: "05:45" }),
    });
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout)).toEqual({ maintenanceTime: "05:45", timezone: "UTC" });
    const listed = await runProcess(["settings", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toHaveLength(4);
    const refused = await runProcess(["settings", "apply", "target"], { stdin: "{}" });
    expect(refused).toMatchObject({ code: 1, stdout: "" });
    expect(refused.stderr).toContain("endpoint:");
    const unreachable = await runProcess(["settings", "list"], {
      env: { DATABASE_URL: "postgres://backups:backups@127.0.0.1:9/backups" },
    });
    expect(unreachable).toMatchObject({ code: 1, stdout: "" });
    expect(unreachable.stderr).toContain("Something went wrong. Try again.\n");
    expect(unreachable.stderr).toContain('"msg":"command failed"');
  });

  it("writes all of a long output to a slow reader before it exits", async () => {
    await getDb()
      .insert(sources)
      .values(
        Array.from({ length: 1500 }, (_, index) => ({
          kind: "app",
          name: `App ${index}`,
          schedule: SCHEDULE,
          retention: DEFAULT_RETENTION,
          config: {},
          secrets: {},
        })),
      );
    const shown = await runProcess(["settings", "show", "sources"], { readAfterMs: 1000 });
    expect(shown.code).toBe(0);
    expect(shown.stdout.length).toBeGreaterThan(200_000);
    expect((JSON.parse(shown.stdout) as { items: unknown[] }).items).toHaveLength(1500);
  });
});
