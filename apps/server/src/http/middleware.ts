import { randomUUID } from "node:crypto";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { z } from "zod";
import { config } from "../config";
import { getDb } from "../db/client";
import { resolvePrincipal } from "../auth/resolve";
import type { UserPrincipal } from "../auth/principal";
import { logger } from "../logger";
import type { AppEnv } from "./env";
import { AppError, parseWith, unauthorized } from "./errors";
import { parseJsonBody } from "./json";

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  c.set("requestId", id);
  c.header("x-request-id", id);
  await next();
};

export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const started = performance.now();
  await next();
  const path = c.req.path;
  if (path.startsWith("/-/") || path.startsWith("/assets/")) return;
  logger.info(
    {
      requestId: c.get("requestId"),
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    },
    "request",
  );
};

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("principal", await resolvePrincipal(getDb(), c.req.raw.headers));
  await next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cross-site request protection for the browser: changes need an Origin of
 * the application itself. Agents use their own routes (/api/agent) with
 * tokens and never reach this.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header("origin");
  const allowed = new URL(config().APP_URL).origin;
  if (origin ? origin !== allowed : c.req.header("sec-fetch-site") !== "same-origin") {
    throw new AppError(403, "forbidden", "Cross-site request rejected");
  }
  await next();
};

/** An admin signed in through the web app (the only people who sign in); 401 otherwise. */
export function requireAdmin(c: Context<AppEnv>): UserPrincipal {
  const principal = c.get("principal");
  if (!principal || !principal.isAdmin) throw unauthorized();
  return principal;
}

/** The JSON body validated with a shared schema. */
export async function jsonBody<T extends z.ZodType, E extends Env>(
  c: Context<E>,
  schema: T,
): Promise<z.infer<T>> {
  return parseJsonBody(await c.req.text(), schema);
}

export function queryOf<T extends z.ZodType, E extends Env>(c: Context<E>, schema: T): z.infer<T> {
  return parseWith(schema, c.req.query());
}

/** A route parameter that must be a UUID (404 otherwise, like an unknown id). */
export function idParam<E extends Env>(c: Context<E>, name = "id"): string {
  const value = c.req.param(name) ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(404, "not_found", "Not found");
  }
  return value.toLowerCase();
}
