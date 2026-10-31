import type { Db } from "./db.js";
import { rowToEvent } from "./ingest.js";
import type { StoredEvent } from "./schema.js";

export interface Range {
  from?: string;
  to?: string;
}

function whereClause(range: Range, params: unknown[], extra: string[] = [], alias = "") {
  const col = alias ? `${alias}.ts` : "ts";
  const clauses = [...extra];
  if (range.from) {
    params.push(range.from);
    clauses.push(`${col} >= $${params.length}::timestamptz`);
  }
  if (range.to) {
    params.push(range.to);
    clauses.push(`${col} < $${params.length}::timestamptz`);
  }
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export async function summary(db: Db, range: Range) {
  const params: unknown[] = [];
  const { rows } = await db.query(
    `SELECT count(*)::int AS total, count(DISTINCT user_id)::int AS users, min(ts) AS first, max(ts) AS last
     FROM events ${whereClause(range, params)}`,
    params,
  );
  const r = rows[0];
  return {
    totalEvents: r.total as number,
    uniqueUsers: r.users as number,
    firstEventAt: r.first ? (r.first as Date).toISOString() : null,
    lastEventAt: r.last ? (r.last as Date).toISOString() : null,
  };
}

export async function byType(db: Db, range: Range) {
  const params: unknown[] = [];
  const { rows } = await db.query(
    `SELECT type, count(*)::int AS count FROM events ${whereClause(range, params)} GROUP BY type ORDER BY count DESC, type`,
    params,
  );
  return rows as Array<{ type: string; count: number }>;
}

const HOUR = 3_600_000;
const MAX_FILLED_BUCKETS = 24 * 31;
const floorHour = (ms: number) => Math.floor(ms / HOUR) * HOUR;

/** Pad missing hours with zeros so charts are not misleading. Skipped for very long spans. */
export function fillHours(
  rows: Array<{ hour: string; count: number }>,
  range: Range,
  now = new Date(),
): Array<{ hour: string; count: number }> {
  if (rows.length === 0 && !range.from) return [];
  const byHour = new Map(rows.map((r) => [Date.parse(r.hour), r.count]));
  const first = rows.length ? Date.parse(rows[0]!.hour) : undefined;
  const last = rows.length ? Date.parse(rows[rows.length - 1]!.hour) : undefined;
  const start = range.from ? floorHour(Date.parse(range.from)) : first!;
  const end = range.to ? floorHour(Date.parse(range.to) - 1) : range.from ? floorHour(now.getTime()) : last!;
  if (end < start || (end - start) / HOUR + 1 > MAX_FILLED_BUCKETS) return rows;
  const out: Array<{ hour: string; count: number }> = [];
  for (let t = start; t <= end; t += HOUR) {
    out.push({ hour: new Date(t).toISOString().replace(".000Z", "Z"), count: byHour.get(t) ?? 0 });
  }
  return out;
}

export async function byHour(db: Db, range: Range, type?: string) {
  const params: unknown[] = [];
  const extra: string[] = [];
  if (type) {
    params.push(type);
    extra.push(`type = $${params.length}`);
  }
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('hour', ts AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS hour, count(*)::int AS count
     FROM events ${whereClause(range, params, extra)} GROUP BY 1 ORDER BY 1`,
    params,
  );
  return fillHours(rows as Array<{ hour: string; count: number }>, range);
}

/**
 * Ordered funnel: a user reaches step N only if they did step N at or after the time they reached
 * step N-1 (using their earliest qualifying event each time). With `windowHours`, every step must
 * also happen within that many hours of the user's first step.
 */
export async function funnel(db: Db, steps: string[], range: Range, windowHours?: number) {
  const params: unknown[] = [...steps];
  const idx = (v: unknown) => (params.push(v), params.length);
  const fromIdx = range.from ? idx(range.from) : 0;
  const toIdx = range.to ? idx(range.to) : 0;
  const winIdx = windowHours ? idx(windowHours) : 0;

  const bounds = (a: string) =>
    [fromIdx && `${a}.ts >= $${fromIdx}::timestamptz`, toIdx && `${a}.ts < $${toIdx}::timestamptz`].filter(Boolean) as string[];

  const ctes: string[] = [
    `s1 AS (SELECT e.user_id, MIN(e.ts) AS t0, MIN(e.ts) AS t FROM events e
            WHERE ${["e.type = $1", ...bounds("e")].join(" AND ")} GROUP BY e.user_id)`,
  ];
  for (let k = 2; k <= steps.length; k++) {
    const cond = [`e.type = $${k}`, `e.ts >= p.t`, ...bounds("e")];
    if (winIdx) cond.push(`e.ts <= p.t0 + ($${winIdx}::double precision * interval '1 hour')`);
    ctes.push(
      `s${k} AS (SELECT e.user_id, p.t0, MIN(e.ts) AS t FROM events e JOIN s${k - 1} p ON p.user_id = e.user_id
              WHERE ${cond.join(" AND ")} GROUP BY e.user_id, p.t0)`,
    );
  }
  const counts = steps.map((_, i) => `(SELECT count(*)::int FROM s${i + 1}) AS c${i + 1}`).join(", ");
  const { rows } = await db.query(`WITH ${ctes.join(",\n")} SELECT ${counts}`, params);

  const users = steps.map((_, i) => rows[0][`c${i + 1}`] as number);
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return steps.map((step, i) => ({
    step,
    users: users[i]!,
    conversionFromPrevious: i === 0 ? null : users[i - 1]! > 0 ? round(users[i]! / users[i - 1]!) : null,
    conversionFromFirst: users[0]! > 0 ? round(users[i]! / users[0]!) : null,
  }));
}

export async function recent(db: Db, limit: number): Promise<StoredEvent[]> {
  const { rows } = await db.query(
    `SELECT event_id, type, user_id, ts, properties FROM events ORDER BY ts DESC, event_id DESC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToEvent);
}
