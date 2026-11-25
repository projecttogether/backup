import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  agentCompleteSchema,
  agentFailSchema,
  agentPollSchema,
  agentProgressSchema,
  AGENT_TOKEN,
} from "@backup/shared/api/agent";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { AppError, badRequest, unauthorized } from "../http/errors";
import { idParam, jsonBody } from "../http/middleware";
import { completeJob, failJob, partBytes, poll, receivePart, recordJobProgress } from "../sources/agent";
import { sourceByAgentToken, type SourceRow } from "../sources/service";

type AgentEnv = AppEnv & { Variables: { source: SourceRow; receivedAt: number } };

/** The backup-agent protocol (agent/README.md): the source's token in the Authorization header. */
export function agentRoutes() {
  const router = new Hono<AgentEnv>();
  router.use("*", async (c, next) => {
    // Before anything that may wait: a request of an earlier attempt of a run must not reach its retry.
    c.set("receivedAt", Date.now());
    c.header("cache-control", "no-store");
    const match = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "");
    const token = match?.[1];
    if (!token || !AGENT_TOKEN.test(token)) throw unauthorized("Send the source's token");
    const source = await sourceByAgentToken(getDb(), token);
    if (!source) throw unauthorized("Unknown token: the source was deleted or has a new token");
    c.set("source", source);
    await next();
  });

  router.post("/poll", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const report = await jsonBody(c, agentPollSchema);
    return c.json(await poll(getDb(), c.get("source"), report));
  });

  router.put(
    "/jobs/:id/parts/:part",
    bodyLimit({
      maxSize: partBytes(),
      onError: () => {
        throw new AppError(413, "payload_too_large", "The part is larger than partBytes");
      },
    }),
    async (c) => {
      const runId = idParam(c);
      const text = c.req.param("part");
      if (!/^\d{1,9}$/.test(text)) throw badRequest("The part number must be a number");
      const body = Buffer.from(await c.req.arrayBuffer());
      await receivePart(
        getDb(),
        c.get("source"),
        runId,
        Number(text),
        c.req.header("x-part-sha256"),
        body,
        c.get("receivedAt"),
      );
      return c.body(null, 204);
    },
  );

  router.post("/jobs/:id/progress", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const runId = idParam(c);
    await jsonBody(c, agentProgressSchema);
    await recordJobProgress(getDb(), c.get("source"), runId, c.get("receivedAt"));
    return c.body(null, 204);
  });

  router.post("/jobs/:id/complete", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const runId = idParam(c);
    const totals = await jsonBody(c, agentCompleteSchema);
    await completeJob(getDb(), c.get("source"), runId, totals, c.get("receivedAt"));
    return c.json({ status: "finishing" }, 202);
  });

  router.post("/jobs/:id/fail", bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const runId = idParam(c);
    const { message } = await jsonBody(c, agentFailSchema);
    await failJob(getDb(), c.get("source"), runId, message, c.get("receivedAt"));
    return c.body(null, 204);
  });

  router.all("*", (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  return router;
}
