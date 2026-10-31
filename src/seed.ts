/**
 * Seed / load script. Talks to the HTTP API, exactly like a real producer would.
 *
 *   npm run seed                      ~1,000 events over the last 24h (deterministic ids)
 *   npm run seed                      run it again: everything is reported as duplicates
 *   npm run seed -- --live            stream new events continuously so the live feed moves
 *   npm run seed -- --count 5000 --hours 72 --url http://localhost:3000
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { EventInput } from "./schema.js";

type SeedEvent = Omit<EventInput, "properties"> & { properties: Record<string, unknown> };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAGES = ["/", "/pricing", "/docs", "/blog/launch", "/features", "/signup"];
const ELEMENTS = ["cta_hero", "pricing_toggle", "nav_signup", "docs_search", "add_to_cart"];
const SKUS = ["starter", "team", "enterprise"];

/**
 * Generates realistic sessions: everyone views, ~55% click, ~30% of clickers purchase.
 * Same seed => same event_ids, so re-running the seed demonstrates idempotency.
 */
export function generateEvents(count: number, hours: number, seed = 42, now = Date.now()): SeedEvent[] {
  const rnd = mulberry32(seed);
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const users = Math.max(5, Math.round(count / 2.5)); // ~1 session per user, so the funnel is not inflated by repeat visitors
  const events: SeedEvent[] = [];
  let n = 0;
  const id = () => `evt_${seed.toString(36)}_${(n++).toString(36).padStart(5, "0")}`;
  const iso = (ms: number) => new Date(ms).toISOString();

  while (events.length < count) {
    const user = `u_${1 + Math.floor(rnd() * users)}`;
    const start = now - 20 * 60_000 - rnd() * (hours * 3_600_000 - 20 * 60_000);
    let t = start;
    events.push({ event_id: id(), type: "viewed", user_id: user, timestamp: iso(t), properties: { page: pick(PAGES) } });
    if (rnd() < 0.55) {
      t += 5_000 + rnd() * 115_000;
      events.push({ event_id: id(), type: "clicked", user_id: user, timestamp: iso(t), properties: { element: pick(ELEMENTS) } });
      if (rnd() < 0.3) {
        t += 30_000 + rnd() * 570_000;
        events.push({
          event_id: id(),
          type: "purchased",
          user_id: user,
          timestamp: iso(t),
          properties: { sku: pick(SKUS), amount: Math.round((10 + rnd() * 190) * 100) / 100, currency: "USD" },
        });
      }
    }
  }
  return events.slice(0, count);
}

async function post(url: string, body: unknown) {
  const res = await fetch(`${url}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as any;
  if (res.status >= 400 && res.status !== 400) throw new Error(`POST /events -> HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json as { received: number; accepted: number; duplicates: number; rejected: number };
}

async function sendAll(url: string, events: SeedEvent[], batch: number) {
  const total = { received: 0, accepted: 0, duplicates: 0, rejected: 0 };
  for (let i = 0; i < events.length; i += batch) {
    const r = await post(url, events.slice(i, i + batch));
    for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += r[k];
  }
  return total;
}

async function live(url: string, rate: number) {
  const stage = new Map<string, number>();
  const users = Array.from({ length: 40 }, (_, i) => `u_live_${i + 1}`);
  const types = ["viewed", "clicked", "purchased"];
  let sent = 0;
  console.log(`Streaming ~${rate} events/sec to ${url} (Ctrl+C to stop)`);
  for (;;) {
    const user = users[Math.floor(Math.random() * users.length)]!;
    const s = stage.get(user);
    let next = 0;
    if (s === 0 && Math.random() < 0.5) next = 1;
    else if (s === 1 && Math.random() < 0.4) next = 2;
    else if (s === 2 && Math.random() < 0.5) next = 0;
    else if (s !== undefined) next = s;
    stage.set(user, next);
    const type = types[next]!;
    const properties = type === "viewed" ? { page: PAGES[Math.floor(Math.random() * PAGES.length)] } : type === "clicked" ? { element: ELEMENTS[Math.floor(Math.random() * ELEMENTS.length)] } : { sku: SKUS[Math.floor(Math.random() * SKUS.length)], amount: Math.round((10 + Math.random() * 190) * 100) / 100, currency: "USD" };
    await post(url, { event_id: randomUUID(), type, user_id: user, timestamp: new Date().toISOString(), properties });
    if (++sent % 10 === 0) process.stdout.write(`\rsent ${sent}`);
    await new Promise((r) => setTimeout(r, 1000 / rate));
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: process.env.API_URL ?? "http://localhost:3000" },
      count: { type: "string", default: "1000" },
      hours: { type: "string", default: "24" },
      seed: { type: "string", default: "42" },
      batch: { type: "string", default: "200" },
      rate: { type: "string", default: "4" },
      live: { type: "boolean", default: false },
    },
  });
  const url = values.url!.replace(/\/$/, "");
  if (values.live) return live(url, Number(values.rate));

  const events = generateEvents(Number(values.count), Number(values.hours), Number(values.seed));
  const t0 = Date.now();
  const r = await sendAll(url, events, Number(values.batch));
  console.log(`Sent ${r.received} events in ${Date.now() - t0}ms: accepted=${r.accepted} duplicates=${r.duplicates} rejected=${r.rejected}`);

  const replay = await sendAll(url, events.slice(0, 10), 10);
  console.log(`Re-sent the first 10 events: accepted=${replay.accepted} duplicates=${replay.duplicates} (idempotency check)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
