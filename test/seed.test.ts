import { describe, expect, it } from "vitest";
import { eventSchema } from "../src/schema.js";
import { generateEvents } from "../src/seed.js";

describe("seed generator", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");

  it("produces exactly N schema-valid events with unique ids, none in the future", () => {
    const events = generateEvents(1000, 24, 42, now);
    expect(events).toHaveLength(1000);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(1000);
    for (const e of events) {
      expect(eventSchema.safeParse(e).success).toBe(true);
      expect(Date.parse(e.timestamp)).toBeLessThanOrEqual(now);
    }
  });

  it("is deterministic, so re-running the seed replays the same ids", () => {
    const a = generateEvents(200, 24, 7, now).map((e) => e.event_id);
    const b = generateEvents(200, 24, 7, now + 5000).map((e) => e.event_id);
    expect(a).toEqual(b);
  });

  it("has a funnel shape: views > clicks > purchases", () => {
    const counts: Record<string, number> = {};
    for (const e of generateEvents(1000, 24, 42, now)) counts[e.type] = (counts[e.type] ?? 0) + 1;
    expect(counts.viewed!).toBeGreaterThan(counts.clicked!);
    expect(counts.clicked!).toBeGreaterThan(counts.purchased!);
    expect(counts.purchased!).toBeGreaterThan(0);
  });
});
