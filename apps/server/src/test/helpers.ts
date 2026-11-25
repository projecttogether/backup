import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { createApp } from "../http/app";

/** Empties every table between tests. */
export async function resetDatabase() {
  await getDb().execute(sql`
    truncate table runs, sources, settings, audit_log, sessions, accounts, verifications, auth_rate_limits, users
      restart identity cascade
  `);
}

/** A person who signed in; an admin unless told otherwise. */
export async function createUser(options: { email?: string; name?: string; isAdmin?: boolean } = {}) {
  const email = options.email ?? `person-${Math.random().toString(36).slice(2, 8)}@example.org`;
  const isAdmin = options.isAdmin ?? true;
  const [user] = await getDb()
    .insert(users)
    .values({
      email,
      name: options.name ?? email.split("@")[0]!,
      isAdmin,
      adminSource: isAdmin ? "email" : null,
    })
    .returning();
  return user!;
}

let app: ReturnType<typeof createApp> | undefined;

export function testApp() {
  app ??= createApp();
  return app;
}

/**
 * A request to the app as `userId` in the web app (the test resolver reads
 * the x-test-user header), or with a bearer `token` (agents). JSON bodies
 * are sent with the app's origin; `raw` sends bytes.
 */
export async function request(
  method: string,
  path: string,
  options: {
    userId?: string;
    token?: string;
    body?: unknown;
    raw?: Uint8Array;
    headers?: Record<string, string>;
  } = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are read loosely
): Promise<{ status: number; body: any; headers: Headers; bytes: Buffer }> {
  const headers: Record<string, string> = {
    origin: "http://localhost:3000",
    accept: "application/json",
    ...options.headers,
  };
  if (options.userId) headers["x-test-user"] = options.userId;
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.raw) headers["content-type"] = "application/octet-stream";
  const response = await testApp().request(path, {
    method,
    headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const type = response.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = type.includes("json") || type.startsWith("text/") ? bytes.toString("utf8") : "";
  return {
    status: response.status,
    body: text && type.includes("json") ? JSON.parse(text) : text,
    headers: response.headers,
    bytes,
  };
}

/** Waits until `check` returns a value (not undefined), polling every 100 ms. */
export async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The S3 storage of compose.dev.yaml (CI starts the same). */
export const TEST_S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:9114",
  region: "us-east-1",
  bucket: process.env.TEST_S3_BUCKET ?? "backups",
  accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? "backups",
  secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? "backups-dev-secret",
};

/**
 * A target with a new, empty repository (a fresh folder in the test bucket),
 * created with the real restic, as an admin would in the app.
 */
export async function setUpTarget(admin: { id: string; email: string }) {
  const { saveTarget, initializeTarget } = await import("../target/target");
  const actor = {
    kind: "user" as const,
    id: admin.id,
    email: admin.email,
    name: "",
    image: null,
    isAdmin: true,
  };
  const prefix = `test/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await saveTarget(
    getDb(),
    {
      endpoint: TEST_S3.endpoint,
      region: TEST_S3.region,
      bucket: TEST_S3.bucket,
      prefix,
      accessKeyId: TEST_S3.accessKeyId,
      secretAccessKey: TEST_S3.secretAccessKey,
    },
    actor,
  );
  await initializeTarget(getDb(), actor);
  return { prefix, actor };
}
