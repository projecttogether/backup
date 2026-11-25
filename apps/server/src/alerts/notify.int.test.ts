import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETENTION } from "@backup/shared/api/schedule";
import { getDb } from "../db/client";
import { runs, sources } from "../db/schema";
import { createUser, request, resetDatabase, setUpTarget } from "../test/helpers";
import { readSetting, writeSetting } from "../core/settings";
import { checkAlerts, NOTIFICATIONS_KEY, sealHeartbeatUrl } from "./notify";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/** Mailpit of compose.dev.yaml (CI starts the same). */
const MAILPIT = process.env.TEST_MAILPIT_URL ?? "http://localhost:8125";
const SMTP_PORT = Number(process.env.TEST_SMTP_PORT ?? 1035);

async function mails(): Promise<{ Subject: string; To: { Address: string }[] }[]> {
  const response = await fetch(`${MAILPIT}/api/v1/messages`);
  return ((await response.json()) as { messages: { Subject: string; To: { Address: string }[] }[] }).messages;
}

const email = {
  enabled: true,
  host: "localhost",
  port: SMTP_PORT,
  security: "none",
  username: "",
  password: "",
  from: "backups@example.org",
  recipients: ["it@example.org"],
};

describe("alerts", () => {
  beforeEach(async () => {
    await resetDatabase();
    await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  });

  it("emails once when a backup fails, and when it works again", async () => {
    const admin = await createUser();
    const saved = await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: { email: { ...email, password: "smtp-pass" }, heartbeatUrl: "", notifyRecovery: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.email).toMatchObject({ passwordHint: "…pass", recipients: ["it@example.org"] });
    expect(JSON.stringify(saved.body)).not.toContain("smtp-pass");
    // Without credentials on this server: a username-less setup.
    await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: { email, heartbeatUrl: "", notifyRecovery: true },
    });
    const test = await request("POST", "/api/v1/notifications/test-email", { userId: admin.id, body: {} });
    expect(test.body).toEqual({ ok: true, message: "Sent. Check the recipients' inboxes." });

    const created = await request("POST", "/api/v1/sources", {
      userId: admin.id,
      body: {
        kind: "app",
        name: "Tickets",
        schedule: { type: "daily", time: "02:00" },
        retention: DEFAULT_RETENTION,
      },
    });
    const sourceId = created.body.source.id as string;
    await getDb().insert(runs).values({
      kind: "backup",
      sourceId,
      trigger: "schedule",
      status: "failed",
      finishedAt: new Date(),
      error: "The agent reported: pg_dump failed",
    });
    // The mail server is down: nothing counts as sent, so the next check tries again.
    await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: { email: { ...email, port: 1 }, heartbeatUrl: "", notifyRecovery: true },
    });
    await checkAlerts(getDb());
    const [unsent] = await getDb().select().from(sources).where(eq(sources.id, sourceId));
    expect(unsent!.alertState).toBeNull();
    await request("PUT", "/api/v1/notifications", {
      userId: admin.id,
      body: { email, heartbeatUrl: "", notifyRecovery: true },
    });
    await checkAlerts(getDb());
    await checkAlerts(getDb());
    const failed = (await mails()).filter((mail) => mail.Subject.includes("Backup failed: Tickets"));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.To[0]!.Address).toBe("it@example.org");
    const [alerted] = await getDb().select().from(sources).where(eq(sources.id, sourceId));
    expect(alerted!.alertState).toBe("failed");

    await getDb()
      .insert(runs)
      .values({
        kind: "backup",
        sourceId,
        trigger: "manual",
        status: "succeeded",
        finishedAt: new Date(),
        snapshotId: "a".repeat(64),
      });
    await getDb().update(sources).set({ lastSuccessAt: new Date() }).where(eq(sources.id, sourceId));
    await checkAlerts(getDb());
    expect((await mails()).map((mail) => mail.Subject)).toContain("[Backup] Backup back to normal: Tickets");
  });

  it("shows the mail server's answer to a failed test, without the login", async () => {
    const admin = await createUser();
    const login = { username: "backups@example.org", password: "wrong-smtp-pass" };
    const server = createTcpServer((socket) => {
      socket.on("error", () => undefined);
      socket.write("220 mail.example.org ESMTP\r\n");
      socket.on("data", (data) =>
        socket.write(
          String(data).startsWith("EHLO")
            ? "250-mail.example.org\r\n250 AUTH PLAIN\r\n"
            : `535 5.7.8 ${login.username}: ${login.password} is not the password\r\n`,
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await request("PUT", "/api/v1/notifications", {
        userId: admin.id,
        body: {
          email: { ...email, host: "127.0.0.1", port, ...login },
          heartbeatUrl: "",
          notifyRecovery: true,
        },
      });
      const test = await request("POST", "/api/v1/notifications/test-email", { userId: admin.id, body: {} });
      expect(test.body).toEqual({
        ok: false,
        message: "The mail server refused: 535 5.7.8 ***: *** is not the password",
      });
    } finally {
      server.close();
    }
  });

  it("alerts on an overdue source while a backup of it waits in the queue", async () => {
    const admin = await createUser();
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping/abc`;
    try {
      await request("PUT", "/api/v1/notifications", {
        userId: admin.id,
        body: { email, heartbeatUrl: url, notifyRecovery: true },
      });
      await setUpTarget(admin);
      const created = await request("POST", "/api/v1/sources", {
        userId: admin.id,
        body: {
          kind: "app",
          name: "Tickets",
          schedule: { type: "daily", time: "02:00" },
          retention: DEFAULT_RETENTION,
        },
      });
      const sourceId = created.body.source.id as string;
      // Never backed up since it was added ten days ago, and its run waits behind a long one.
      await getDb()
        .update(sources)
        .set({ createdAt: new Date(Date.now() - 10 * 86_400_000) })
        .where(eq(sources.id, sourceId));
      await getDb().insert(runs).values({ kind: "backup", sourceId, trigger: "schedule", status: "queued" });
      await checkAlerts(getDb());
      expect((await mails()).map((mail) => mail.Subject)).toContain("[Backup] Backup is overdue: Tickets");
      const [alerted] = await getDb().select().from(sources).where(eq(sources.id, sourceId));
      expect(alerted!.alertState).toBe("overdue");
      expect(hits).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("calls the heartbeat only while all is well", async () => {
    const admin = await createUser();
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping/abc`;
    try {
      await request("PUT", "/api/v1/notifications", {
        userId: admin.id,
        body: { email: { ...email, enabled: false }, heartbeatUrl: url, notifyRecovery: true },
      });
      // No repository yet: not well.
      await checkAlerts(getDb());
      expect(hits).toEqual([]);
      await setUpTarget(admin);
      await checkAlerts(getDb());
      expect(hits).toEqual(["/ping/abc"]);
      // Not again within 15 minutes.
      await checkAlerts(getDb());
      expect(hits).toHaveLength(1);
      const view = await request("GET", "/api/v1/notifications", { userId: admin.id });
      expect(view.body.heartbeat).toMatchObject({ ok: true, message: null });
      expect(view.body.heartbeatUrlHint).toBe(`${new URL(url).origin}/…`);
      expect(JSON.stringify(view.body)).not.toContain("ping/abc");
    } finally {
      server.close();
    }
  });

  it("encrypts the heartbeat URL of 0.1.4 once, keeps it when it is left out, and drops it on null", async () => {
    const admin = await createUser();
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping/plain`;
    const save = (heartbeatUrl?: string | null) =>
      request("PUT", "/api/v1/notifications", {
        userId: admin.id,
        body: { email: { ...email, enabled: false }, heartbeatUrl, notifyRecovery: true },
      });
    const test = async () =>
      (await request("POST", "/api/v1/notifications/test-heartbeat", { userId: admin.id, body: {} })).body;
    const stored = async () => JSON.stringify(await readSetting(getDb(), NOTIFICATIONS_KEY));
    try {
      await save("");
      const plain = await readSetting<Record<string, unknown>>(getDb(), NOTIFICATIONS_KEY);
      await writeSetting(getDb(), NOTIFICATIONS_KEY, { ...plain, heartbeatUrl: url });
      // Before the worker encrypted it, it works and is not shown.
      expect(await test()).toMatchObject({ ok: true });
      const view = await request("GET", "/api/v1/notifications", { userId: admin.id });
      expect(JSON.stringify(view.body)).not.toContain("ping/plain");
      // Two workers that start, and a save that keeps the URL, at the same time.
      await Promise.all([sealHeartbeatUrl(getDb()), save(), sealHeartbeatUrl(getDb())]);
      const sealed = await stored();
      expect(sealed).toMatch(/"heartbeatUrl":"v1:/);
      expect(sealed).not.toContain("ping/plain");
      await sealHeartbeatUrl(getDb());
      expect(await stored()).toBe(sealed);
      expect((await save()).body).toMatchObject({ heartbeatUrlHint: `${new URL(url).origin}/…` });
      expect(await test()).toMatchObject({ ok: true });
      expect(hits).toEqual(["/ping/plain", "/ping/plain"]);

      // Encrypted with another ENCRYPTION_KEY: said, not called.
      const value = await readSetting<Record<string, unknown>>(getDb(), NOTIFICATIONS_KEY);
      await writeSetting(getDb(), NOTIFICATIONS_KEY, { ...value, heartbeatUrl: "v1:AAAA:AAAA:AAAA" });
      expect(await test()).toMatchObject({ ok: false, message: expect.stringContaining("enter it again") });
      const unreadable = await request("GET", "/api/v1/notifications", { userId: admin.id });
      expect(unreadable.body.heartbeatUrlHint).toBe("…");

      expect((await save(null)).body).toMatchObject({ heartbeatUrlHint: null });
      expect(await test()).toEqual({ ok: false, message: "Set a heartbeat URL first" });
      expect(hits).toHaveLength(2);
    } finally {
      server.close();
    }
  });
});
