import { z } from "zod";

/**
 * Settings from the environment. Read them only through `config()`; blank
 * values count as unset. Document every variable in docs/configuration.md.
 * Everything else (sources, the target, notifications) is set up in the app.
 */
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const withDefault = <T extends z.ZodType>(schema: T, fallback: z.input<T>) =>
  z.preprocess(blankToUndefined, schema.default(fallback as never));
const flag = (fallback: boolean) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() !== ""
        ? ["1", "true", "yes", "on"].includes(value.trim().toLowerCase())
        : undefined,
    z.boolean().default(fallback),
  );

/** Example values (.env.example): never valid where the app is in use. */
const EXAMPLE_SECRETS = new Set([
  "change-me-to-a-long-random-value",
  "development-secret-development-secret",
  "ZGV2ZWxvcG1lbnQta2V5LWRldmVsb3BtZW50LWtleSE=",
]);

const schema = z
  .object({
    NODE_ENV: withDefault(z.enum(["development", "test", "production"]), "development"),
    /** Which part of the application this process runs. */
    APP_ROLE: withDefault(z.enum(["all", "web", "worker", "migrate"]), "all"),
    PORT: withDefault(z.coerce.number().int().min(1).max(65535), 3000),
    HOST: withDefault(z.string(), "0.0.0.0"),
    /** The public URL of the app, e.g. https://backup.example.org */
    APP_URL: withDefault(z.url(), "http://localhost:3000"),
    APP_NAME: withDefault(z.string().min(1).max(100), "Backup"),
    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_SIZE: withDefault(z.coerce.number().int().min(1).max(200), 10),
    /** Longest database statement of the web app and the worker, in seconds; 0: no limit. */
    DATABASE_STATEMENT_TIMEOUT_SECONDS: withDefault(z.coerce.number().int().min(0).max(86_400), 60),
    /** Signs sessions. At least 32 characters. */
    AUTH_SECRET: z.string().min(32),
    /** Encrypts stored secrets (S3 keys, the repository password, source keys). 32 bytes, base64. */
    ENCRYPTION_KEY: z.string().min(1),
    LOG_LEVEL: withDefault(z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]), "info"),
    /**
     * Reverse proxies in front of the app that append to X-Forwarded-For:
     * `true` (one), a number of hops, or `false`/0 (use the socket address).
     */
    TRUST_PROXY: z.preprocess((value) => {
      if (typeof value !== "string" || value.trim() === "") return undefined;
      const text = value.trim().toLowerCase();
      if (["true", "yes", "on"].includes(text)) return 1;
      if (["false", "no", "off"].includes(text)) return 0;
      return text;
    }, z.coerce.number().int().min(0).max(10).default(0)),
    /** Apply database migrations when the process starts (single-container setups). */
    RUN_MIGRATIONS: flag(false),
    /** Directory with the built web app. */
    WEB_DIST_DIR: optional(z.string()),
    MIGRATIONS_DIR: optional(z.string()),
    /**
     * Local data: the copies of Google Drive and Personio between runs
     * (`staging/`) and restic's cache (`cache/`). Keep it on a volume.
     */
    DATA_DIR: withDefault(z.string(), ".data"),
    /** The restic and rclone programs (the image has both on the PATH). */
    RESTIC_BINARY: withDefault(z.string(), "restic"),
    RCLONE_BINARY: withDefault(z.string(), "rclone"),
    /** pg_dump for this app's own database (the image has version 18). */
    PG_DUMP_BINARY: withDefault(z.string(), "pg_dump"),
    /** Size of the parts in which agents send their stream, in MiB. Proxies must accept bodies this large. */
    AGENT_PART_MB: withDefault(z.coerce.number().int().min(1).max(256), 16),
    /** Seconds between an agent's polls. */
    AGENT_POLL_SECONDS: withDefault(z.coerce.number().int().min(5).max(3600), 30),
    /** The time zone of schedules, as TZ in the container (e.g. Europe/Berlin). */
    TZ: withDefault(z.string(), "UTC"),
    /** Sign-in with an OpenID Connect provider (Keycloak, Microsoft Entra ID, Google, Authentik, …). */
    OIDC_ISSUER: z.url(),
    OIDC_CLIENT_ID: z.string().min(1),
    OIDC_CLIENT_SECRET: z.string().min(1),
    OIDC_PROVIDER_NAME: withDefault(z.string().max(40), "single sign-on"),
    OIDC_SCOPES: withDefault(z.string(), "openid email profile"),
    /** Proof Key for Code Exchange; turn off only for providers that reject it. */
    OIDC_PKCE: flag(true),
    /** The claim with a person's groups, for ADMIN_GROUPS. A dotted name reads a nested claim. */
    OIDC_GROUPS_CLAIM: withDefault(z.string().min(1).max(100), "groups"),
    /** Comma-separated email addresses that are admins (the only people who may sign in). */
    ADMIN_EMAILS: withDefault(z.string(), ""),
    /** Comma-separated groups (from OIDC_GROUPS_CLAIM) whose members are admins. */
    ADMIN_GROUPS: withDefault(z.string(), ""),
    /**
     * Sign in only when the provider says the email address is verified
     * (claim `email_verified`). Turn off only for providers that do not send
     * the claim (Microsoft Entra ID) and where people cannot choose their address.
     */
    OIDC_REQUIRE_EMAIL_VERIFIED: flag(true),
    /** Sessions end this many hours after sign-in; using the app does not extend them. */
    SESSION_HOURS: withDefault(z.coerce.number().int().min(1).max(720), 12),
    /** Days the audit log keeps entries; the worker deletes older ones. 0 keeps them all. */
    AUDIT_LOG_DAYS: withDefault(z.coerce.number().int().min(0).max(36_500), 730),
    /** Days the run history keeps finished runs; 0 keeps them all. */
    RUN_HISTORY_DAYS: withDefault(z.coerce.number().int().min(0).max(36_500), 180),
    /** The worker touches this file every few seconds, for container health checks. */
    WORKER_HEARTBEAT_FILE: optional(z.string()),
    /**
     * The version: the commit an image was built from (its first 12
     * characters), set by the Deploy workflow; unset in images built from source.
     */
    APP_VERSION: optional(z.string().max(100)),
    /** Error reports and performance data to Sentry or a compatible service; off when unset. */
    SENTRY_DSN: optional(z.url()),
    SENTRY_ENVIRONMENT: optional(z.string().max(64)),
    SENTRY_RELEASE: optional(z.string().max(200)),
    /** Share of requests and page loads traced for performance data, 0 to 1. */
    SENTRY_TRACES_SAMPLE_RATE: withDefault(z.coerce.number().min(0).max(1), 0),
  })
  .superRefine((value, ctx) => {
    // A copied .env.example sets NODE_ENV=development: an https address counts too.
    const deployed = value.NODE_ENV === "production" || /^https:/i.test(value.APP_URL);
    for (const key of ["AUTH_SECRET", "ENCRYPTION_KEY"] as const) {
      if (deployed && EXAMPLE_SECRETS.has(value[key])) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Replace the example value (openssl rand -base64 32)",
        });
      }
    }
    if (Buffer.from(value.ENCRYPTION_KEY, "base64").length !== 32) {
      ctx.addIssue({ code: "custom", path: ["ENCRYPTION_KEY"], message: "Must be 32 bytes, base64-encoded" });
    }
    for (const email of splitList(value.ADMIN_EMAILS)) {
      if (!z.email().safeParse(email).success) {
        ctx.addIssue({ code: "custom", path: ["ADMIN_EMAILS"], message: `Not an email address: ${email}` });
      }
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value.TZ });
    } catch {
      ctx.addIssue({ code: "custom", path: ["TZ"], message: `Not a time zone: ${value.TZ}` });
    }
  });

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export type Config = z.infer<typeof schema> & {
  adminEmails: string[];
  adminGroups: string[];
};

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const value = parsed.data;
  cached = {
    ...value,
    APP_URL: value.APP_URL.replace(/\/+$/, ""),
    adminEmails: splitList(value.ADMIN_EMAILS),
    adminGroups: value.ADMIN_GROUPS.split(",")
      .map((group) => group.trim())
      .filter(Boolean),
  };
  return cached;
}

/** Tests only: forget the cached configuration after changing process.env. */
export function resetConfigForTests() {
  cached = undefined;
}
