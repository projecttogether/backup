import os from "node:os";
import path from "node:path";

/**
 * Environment of every test process. Integration tests use TEST_DATABASE_URL
 * (default: the backups_test database of compose.dev.yaml).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://backups:backups@localhost:55460/backups_test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.APP_URL = "http://localhost:3000";
process.env.AUTH_SECRET ??= "test-secret-test-secret-test-secret-1234";
process.env.LOG_LEVEL = "silent";
process.env.OIDC_ISSUER ??= "http://localhost:8114/realms/backups";
process.env.OIDC_CLIENT_ID ??= "backups";
process.env.OIDC_CLIENT_SECRET ??= "test-client-secret";
process.env.ADMIN_EMAILS ??= "root@example.org";
process.env.DATA_DIR ??= path.join(os.tmpdir(), `backups-test-${process.pid}`);
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
