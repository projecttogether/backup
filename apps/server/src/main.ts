import { serve } from "@hono/node-server";
import { config } from "./config";
import { logger } from "./logger";
import { closeDb, getDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { sealHeartbeatUrl } from "./alerts/notify";
import { createApp } from "./http/app";
import { revokeRemovedAdmins, warnAboutSignIn } from "./auth/bootstrap";
import { flushErrorReports } from "./error-reporting";
import { abortAllUploads, failOrphanedUploads, sweepCancelledUploads } from "./sources/agent";
import { startWorker, type Stop } from "./worker";

/**
 * One entry point for every process. APP_ROLE selects what runs:
 *   all      web app and worker (default, simplest deployment)
 *   web      web app, API and the agents' uploads
 *   worker   schedules, Google Drive and Personio backups, upkeep, alerts
 *   migrate  apply database migrations, then exit
 */
async function main() {
  const settings = config();
  const role = settings.APP_ROLE;
  if (role === "migrate") {
    await runMigrations();
    await closeDb();
    return;
  }
  if (settings.RUN_MIGRATIONS) await runMigrations();
  let server: ReturnType<typeof serve> | undefined;
  const stops: Stop[] = [];
  if (role === "all" || role === "web") {
    await revokeRemovedAdmins(getDb());
    await failOrphanedUploads(getDb());
    warnAboutSignIn();
    const app = createApp();
    server = serve({ fetch: app.fetch, port: settings.PORT, hostname: settings.HOST }, (info) => {
      logger.info({ port: info.port, url: settings.APP_URL }, "web app listening");
    });
    const sweep = setInterval(() => {
      void sweepCancelledUploads(getDb()).catch((error: unknown) =>
        logger.warn({ err: error }, "could not check uploads for cancellations"),
      );
    }, 5_000);
    stops.push(async () => {
      clearInterval(sweep);
      await abortAllUploads();
    });
  }
  if (role === "all" || role === "worker") {
    await sealHeartbeatUrl(getDb());
    stops.push(await startWorker());
  }

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    await Promise.allSettled([
      server ? new Promise<void>((resolve) => server!.close(() => resolve())) : Promise.resolve(),
      ...stops.map((stopJob) => stopJob()),
    ]);
    await closeDb();
    await flushErrorReports();
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "startup failed");
  await flushErrorReports();
  process.exit(1);
});
