import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { ev, iso, resetDb, setupApp, setupDb } from "./helpers.js";

let db: Db;
let ctx: ReturnType<typeof setupApp>;
const count = async () => ((await db.query("SELECT count(*)::int AS n FROM events")).rows[0].n as number);
const post = (payload: unknown) => ctx.app.inject({ method: "POST", url: "/events", payload: payload as any });

beforeAll(async () => {
  db = await setupDb();
  ctx = setupApp(db);
  await ctx.app.ready();
});
afterAll(async () => {
  await ctx.app.close();
  await db.end();
});
beforeEach(() => resetDb(db));

describe("POST /events: validation at the edge", () => {
  it("stores a valid single event", async () => {
    const res = await post(ev({ event_id: "evt_ok", properties: { page: "/pricing" } }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: 1, accepted: 1, duplicates: 0, rejected: 0 });
    const row = (await db.query("SELECT * FROM events WHERE event_id = 'evt_ok'")).rows[0];
    expect(row.properties).toEqual({ page: "/pricing" });
  });

  it("rejects a bad event with field-level errors and stores nothing", async () => {
    const res = await post({ event_id: "", type: "Not Valid!", user_id: "u", timestamp: "yesterday", surprise: 1 });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({ received: 1, accepted: 0, rejected: 1 });
    const fields = body.errors[0].errors.map((e: any) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["event_id", "type", "timestamp"]));
    expect(body.errors[0].errors.some((e: any) => /unknown field/.test(e.message) && /surprise/.test(e.message))).toBe(true);
    expect(await count()).toBe(0);
  });

  it("flags missing required fields", async () => {
    const res = await post({ type: "viewed" });
    expect(res.statusCode).toBe(400);
    const fields = res.json().errors[0].errors.map((e: any) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["event_id", "user_id", "timestamp"]));
  });

  it("rejects timestamps far in the future and oversized properties", async () => {
    const future = await post(ev({ timestamp: new Date(Date.now() + 3 * 86_400_000).toISOString() }));
    expect(future.statusCode).toBe(400);
    expect(future.json().errors[0].errors[0].message).toMatch(/24h in the future/);
    const big = await post(ev({ properties: { blob: "x".repeat(5000) } }));
    expect(big.statusCode).toBe(400);
  });

  it("accepts the valid part of a mixed batch (207) and reports the bad indexes", async () => {
    const res = await post([ev(), { nope: true }, ev(), "garbage", ev()]);
    expect(res.statusCode).toBe(207);
    const body = res.json();
    expect(body).toMatchObject({ received: 5, accepted: 3, duplicates: 0, rejected: 2 });
    expect(body.errors.map((e: any) => e.index)).toEqual([1, 3]);
    expect(await count()).toBe(3);
  });

  it("rejects empty bodies, empty arrays and oversized batches", async () => {
    expect((await post([])).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: "POST", url: "/events", headers: { "content-type": "application/json" }, payload: "{not json" })).statusCode).toBe(400);
    const big = await post(Array.from({ length: 1001 }, () => ev()));
    expect(big.statusCode).toBe(413);
    expect(await count()).toBe(0);
  });

  it("stores timestamps with their offset normalised to UTC", async () => {
    await post(ev({ event_id: "evt_tz", timestamp: "2026-10-30T12:00:00+02:00" }));
    const row = (await db.query("SELECT ts FROM events WHERE event_id = 'evt_tz'")).rows[0];
    expect((row.ts as Date).toISOString()).toBe("2026-10-30T10:00:00.000Z");
  });
});

describe("idempotency", () => {
  it("stores a repeated event_id exactly once", async () => {
    const e = ev({ event_id: "evt_dup" });
    const first = await post(e);
    const second = await post(e);
    expect(first.json()).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ accepted: 0, duplicates: 1, rejected: 0 });
    expect(await count()).toBe(1);
  });

  it("keeps the first version when a retry carries different data", async () => {
    await post(ev({ event_id: "evt_same", properties: { v: 1 } }));
    await post(ev({ event_id: "evt_same", properties: { v: 2 } }));
    const row = (await db.query("SELECT properties FROM events WHERE event_id = 'evt_same'")).rows[0];
    expect(row.properties).toEqual({ v: 1 });
  });

  it("dedupes within a single batch", async () => {
    const e = ev({ event_id: "evt_in_batch" });
    const res = await post([e, e, ev()]);
    expect(res.json()).toMatchObject({ received: 3, accepted: 2, duplicates: 1 });
    expect(await count()).toBe(2);
  });

  it("survives concurrent duplicate submissions", async () => {
    const e = ev({ event_id: "evt_race" });
    const results = await Promise.all(Array.from({ length: 20 }, () => post(e)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.reduce((n, r) => n + r.json().accepted, 0)).toBe(1);
    expect(await count()).toBe(1);
  });

  it("replaying a whole batch changes nothing", async () => {
    const batch = Array.from({ length: 50 }, () => ev());
    expect((await post(batch)).json().accepted).toBe(50);
    expect((await post(batch)).json()).toMatchObject({ accepted: 0, duplicates: 50 });
    expect(await count()).toBe(50);
  });
});

describe("live feed (SSE)", () => {
  it("pushes new events to subscribers, but not duplicates", async () => {
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
    const ctrl = new AbortController();
    const res = await fetch(`${base}/events/stream`, { signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const read = async (ms: number) => {
      const r = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
      return r && !r.done ? dec.decode(r.value) : null;
    };

    expect(await read(2000)).toContain(": connected");

    const e = ev({ event_id: "evt_live", type: "clicked" });
    const send = (p: unknown) => fetch(`${base}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p) });
    await send(e);
    const chunk = await read(2000);
    expect(chunk).toMatch(/^data: /);
    expect(JSON.parse(chunk!.replace(/^data: /, "").trim())).toMatchObject({ event_id: "evt_live", type: "clicked" });

    await send(e); // duplicate: nothing should be pushed
    expect(await read(400)).toBeNull();

    ctrl.abort();
  });
});

describe("misc endpoints", () => {
  it("health and recent", async () => {
    expect((await ctx.app.inject("/health")).json()).toEqual({ status: "ok" });
    await post([ev({ event_id: "old", timestamp: iso(3_600_000) }), ev({ event_id: "new", timestamp: iso(1000) })]);
    const recent = (await ctx.app.inject("/events/recent?limit=1")).json();
    expect(recent.events.map((x: any) => x.event_id)).toEqual(["new"]);
  });
});

describe("error quality", () => {
  it("reports one clear message for an unparseable timestamp", async () => {
    const res = await post(ev({ timestamp: "nope" }));
    const msgs = res.json().errors[0].errors.filter((e: any) => e.field === "timestamp");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/ISO 8601/);
  });
});
