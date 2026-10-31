import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { ingest } from "../src/ingest.js";
import * as q from "../src/queries.js";
import { fillHours } from "../src/queries.js";
import { at, BASE, ev, resetDb, setupApp, setupDb } from "./helpers.js";

let db: Db;
const put = (events: Array<Record<string, unknown>>) => ingest(db, events);
const u = (user_id: string, type: string, minutes: number) => ev({ user_id, type, timestamp: at(minutes) });

beforeAll(async () => {
  db = await setupDb();
});
afterAll(() => db.end());
beforeEach(() => resetDb(db));

describe("aggregations", () => {
  it("counts by type, most frequent first", async () => {
    await put([u("a", "viewed", 0), u("b", "viewed", 1), u("c", "viewed", 2), u("a", "clicked", 3), u("a", "purchased", 4), u("b", "clicked", 5)]);
    expect(await q.byType(db, {})).toEqual([
      { type: "viewed", count: 3 },
      { type: "clicked", count: 2 },
      { type: "purchased", count: 1 },
    ]);
  });

  it("honours the from/to range (to is exclusive)", async () => {
    await put([u("a", "viewed", 0), u("a", "viewed", 30), u("a", "viewed", 60)]);
    const rows = await q.byType(db, { from: at(30), to: at(60) });
    expect(rows).toEqual([{ type: "viewed", count: 1 }]);
  });

  it("counts by hour in UTC and fills empty hours with zero", async () => {
    // 10:05, 10:50 -> 10:00 bucket; 13:10 -> 13:00 bucket; nothing in 11:00 and 12:00
    await put([u("a", "viewed", 5), u("b", "viewed", 50), u("c", "viewed", 190), u("d", "clicked", 195)]);
    const all = await q.byHour(db, {});
    expect(all).toEqual([
      { hour: "2026-10-30T10:00:00Z", count: 2 },
      { hour: "2026-10-30T11:00:00Z", count: 0 },
      { hour: "2026-10-30T12:00:00Z", count: 0 },
      { hour: "2026-10-30T13:00:00Z", count: 2 },
    ]);
    const viewedOnly = await q.byHour(db, {}, "viewed");
    expect(viewedOnly.map((h) => h.count)).toEqual([2, 0, 0, 1]);
  });

  it("summarises totals and unique users", async () => {
    await put([u("a", "viewed", 0), u("a", "clicked", 5), u("b", "viewed", 10)]);
    expect(await q.summary(db, {})).toEqual({
      totalEvents: 3,
      uniqueUsers: 2,
      firstEventAt: new Date(BASE).toISOString(),
      lastEventAt: new Date(BASE + 10 * 60_000).toISOString(),
    });
    expect(await q.summary(db, { from: at(1000) })).toMatchObject({ totalEvents: 0, firstEventAt: null });
  });
});

describe("fillHours", () => {
  it("pads from `from` to now when only `from` is given, and returns [] with no data and no range", () => {
    const now = new Date("2026-10-30T14:30:00Z");
    const out = fillHours([{ hour: "2026-10-30T12:00:00Z", count: 4 }], { from: "2026-10-30T11:20:00Z" }, now);
    expect(out.map((h) => [h.hour, h.count])).toEqual([
      ["2026-10-30T11:00:00Z", 0],
      ["2026-10-30T12:00:00Z", 4],
      ["2026-10-30T13:00:00Z", 0],
      ["2026-10-30T14:00:00Z", 0],
    ]);
    expect(fillHours([], {}, now)).toEqual([]);
  });

  it("does not balloon for huge spans", () => {
    const out = fillHours([{ hour: "2020-01-01T00:00:00Z", count: 1 }, { hour: "2026-01-01T00:00:00Z", count: 1 }], {});
    expect(out).toHaveLength(2);
  });
});

describe("funnel", () => {
  const steps = ["viewed", "clicked", "purchased"];

  it("counts distinct users who completed each step in order", async () => {
    await put([
      // a: full journey
      u("a", "viewed", 0), u("a", "clicked", 1), u("a", "purchased", 2),
      // b: stops after click
      u("b", "viewed", 0), u("b", "clicked", 5),
      // c: only viewed (many times: still one user)
      u("c", "viewed", 0), u("c", "viewed", 1), u("c", "viewed", 2),
      // d: viewed + clicked
      u("d", "viewed", 3), u("d", "clicked", 4),
    ]);
    expect(await q.funnel(db, steps, {})).toEqual([
      { step: "viewed", users: 4, conversionFromPrevious: null, conversionFromFirst: 1 },
      { step: "clicked", users: 3, conversionFromPrevious: 0.75, conversionFromFirst: 0.75 },
      { step: "purchased", users: 1, conversionFromPrevious: 0.3333, conversionFromFirst: 0.25 },
    ]);
  });

  it("respects step order: purchase before click does not count", async () => {
    await put([
      u("x", "viewed", 0), u("x", "purchased", 1), u("x", "clicked", 2), // wrong order
      u("y", "viewed", 0), u("y", "clicked", 1), u("y", "purchased", 2), // right order
    ]);
    const f = await q.funnel(db, steps, {});
    expect(f.map((s) => s.users)).toEqual([2, 2, 1]);
  });

  it("a later re-entry cannot skip a step: clicks before the first view do not count", async () => {
    await put([u("z", "clicked", 0), u("z", "viewed", 5)]);
    expect((await q.funnel(db, steps, {})).map((s) => s.users)).toEqual([1, 0, 0]);
  });

  it("applies the time range to every step", async () => {
    await put([u("a", "viewed", 0), u("a", "clicked", 10), u("b", "viewed", 0), u("b", "clicked", 90)]);
    const f = await q.funnel(db, ["viewed", "clicked"], { to: at(60) });
    expect(f.map((s) => s.users)).toEqual([2, 1]);
  });

  it("applies windowHours measured from the first step", async () => {
    await put([
      u("fast", "viewed", 0), u("fast", "clicked", 30),
      u("slow", "viewed", 0), u("slow", "clicked", 180),
    ]);
    expect((await q.funnel(db, ["viewed", "clicked"], {})).map((s) => s.users)).toEqual([2, 2]);
    expect((await q.funnel(db, ["viewed", "clicked"], {}, 1)).map((s) => s.users)).toEqual([2, 1]);
  });

  it("returns null conversions when nobody entered the funnel", async () => {
    const f = await q.funnel(db, steps, {});
    expect(f.map((s) => s.users)).toEqual([0, 0, 0]);
    expect(f[1]!.conversionFromPrevious).toBeNull();
  });
});

describe("stats HTTP endpoints", () => {
  it("validate and serve query parameters", async () => {
    const { app } = setupApp(db);
    await put([u("a", "viewed", 0), u("a", "clicked", 1)]);
    const funnel = await app.inject("/stats/funnel?steps=viewed,clicked");
    expect(funnel.statusCode).toBe(200);
    expect(funnel.json().steps.map((s: any) => s.users)).toEqual([1, 1]);

    expect((await app.inject("/stats/funnel?steps=viewed")).statusCode).toBe(400);
    expect((await app.inject("/stats/funnel?steps=viewed,viewed")).statusCode).toBe(400);
    expect((await app.inject("/stats/funnel")).statusCode).toBe(400);
    expect((await app.inject("/stats/by-type?from=yesterday")).statusCode).toBe(400);
    expect((await app.inject("/stats/by-type")).json().types).toHaveLength(2);
    expect((await app.inject("/stats/by-hour")).json().hours.length).toBeGreaterThan(0);
    expect((await app.inject("/stats/summary")).json().totalEvents).toBe(2);
    await app.close();
  });
});
