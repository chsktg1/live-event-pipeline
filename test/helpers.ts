import { inject } from "vitest";
import { buildApp } from "../src/app.js";
import { createPool, migrate, type Db } from "../src/db.js";
import { EventHub } from "../src/hub.js";

export async function setupDb(): Promise<Db> {
  const db = createPool(inject("databaseUrl"));
  await migrate(db);
  return db;
}

export const resetDb = (db: Db) => db.query("TRUNCATE events");

export function setupApp(db: Db) {
  const hub = new EventHub(0);
  return { app: buildApp({ db, hub }), hub };
}

let n = 0;
export const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

export function ev(over: Record<string, unknown> = {}) {
  return { event_id: `evt_${++n}_${Math.random().toString(36).slice(2, 8)}`, type: "viewed", user_id: "u_1", timestamp: iso(60_000), properties: {}, ...over };
}

/** A timestamp N minutes after a fixed base, for deterministic ordering tests. */
export const BASE = Date.parse("2026-10-30T10:00:00Z");
export const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
