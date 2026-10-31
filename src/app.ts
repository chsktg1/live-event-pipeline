import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { Db } from "./db.js";
import { EventHub } from "./hub.js";
import { ingest, MAX_BATCH } from "./ingest.js";
import * as q from "./queries.js";
import { byHourQuery, funnelQuery, rangeQuery, recentQuery } from "./schema.js";

export interface AppOptions {
  db: Db;
  hub?: EventHub;
  webDir?: string;
  logger?: boolean;
}

const formatIssues = (e: z.ZodError) => e.issues.map((i) => ({ field: i.path.join(".") || "(query)", message: i.message }));

export function buildApp(opts: AppOptions): FastifyInstance {
  const { db } = opts;
  const hub = opts.hub ?? new EventHub();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2_000_000 });

  app.addHook("onClose", async () => hub.close());

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: formatIssues(err) });
    if (err.statusCode && err.statusCode < 500) {
      const code = err.statusCode === 413 ? "payload_too_large" : err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? "unsupported_media_type" : "bad_request";
      return reply.code(err.statusCode).send({ error: code, message: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async (_req, reply) => {
    try {
      await db.query("SELECT 1");
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "db_unavailable" });
    }
  });

  // ---- ingestion ----------------------------------------------------------
  app.post("/events", async (req, reply) => {
    const body = req.body;
    const items = Array.isArray(body) ? body : body == null ? [] : [body];
    if (items.length === 0) {
      return reply.code(400).send({ error: "empty_request", message: "Send one event object or a non-empty array of events." });
    }
    if (items.length > MAX_BATCH) {
      return reply.code(413).send({ error: "batch_too_large", message: `Max ${MAX_BATCH} events per request; got ${items.length}.` });
    }
    const { summary, inserted } = await ingest(db, items);
    hub.broadcast(inserted); // only genuinely new events go to live viewers
    const status = summary.rejected === 0 ? 200 : summary.accepted + summary.duplicates === 0 ? 400 : 207;
    return reply.code(status).send(summary);
  });

  app.get("/events/recent", async (req) => ({ events: await q.recent(db, recentQuery.parse(req.query).limit) }));

  app.get("/events/stream", (req, reply) => {
    reply.hijack();
    hub.add(reply.raw);
  });

  // ---- queries ------------------------------------------------------------
  app.get("/stats/summary", async (req) => q.summary(db, rangeQuery.parse(req.query)));

  app.get("/stats/by-type", async (req) => ({ types: await q.byType(db, rangeQuery.parse(req.query)) }));

  app.get("/stats/by-hour", async (req) => {
    const { type, ...range } = byHourQuery.parse(req.query);
    return { hours: await q.byHour(db, range, type) };
  });

  app.get("/stats/funnel", async (req) => {
    const { steps, windowHours, ...range } = funnelQuery.parse(req.query);
    return { steps: await q.funnel(db, steps, range, windowHours) };
  });

  // ---- dashboard (built React app), if present -----------------------------
  if (opts.webDir && existsSync(opts.webDir)) {
    app.register(fastifyStatic, { root: opts.webDir });
  }

  return app;
}
