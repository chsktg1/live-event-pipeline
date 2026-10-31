import type { Db } from "./db.js";
import { eventSchema, type StoredEvent } from "./schema.js";

export const MAX_BATCH = 1000;
const MAX_ERRORS_REPORTED = 50;

export interface IngestError {
  index: number;
  event_id?: string;
  errors: Array<{ field: string; message: string }>;
}

export interface IngestSummary {
  received: number;
  accepted: number; // newly stored
  duplicates: number; // valid, but event_id already stored (or repeated within the batch)
  rejected: number; // failed validation
  errors: IngestError[];
}

export interface IngestResult {
  summary: IngestSummary;
  inserted: StoredEvent[]; // only the rows that were actually new
}

const INSERT_SQL = `
INSERT INTO events (event_id, type, user_id, ts, properties)
SELECT e, t, u, ts::timestamptz, p::jsonb
FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS x(e, t, u, ts, p)
ON CONFLICT (event_id) DO NOTHING
RETURNING event_id, type, user_id, ts, properties`;

export function rowToEvent(r: { event_id: string; type: string; user_id: string; ts: Date; properties: Record<string, unknown> }): StoredEvent {
  return { event_id: r.event_id, type: r.type, user_id: r.user_id, timestamp: r.ts.toISOString(), properties: r.properties };
}

/**
 * Validate every item independently, then store the valid ones in one statement.
 * `ON CONFLICT (event_id) DO NOTHING` makes the write idempotent: retries and replays
 * (and even concurrent duplicates) leave exactly one row.
 */
export async function ingest(db: Db, items: unknown[]): Promise<IngestResult> {
  const valid: Array<ReturnType<typeof eventSchema.parse>> = [];
  const errors: IngestError[] = [];
  let rejected = 0;

  items.forEach((item, index) => {
    const parsed = eventSchema.safeParse(item);
    if (parsed.success) return void valid.push(parsed.data);
    rejected++;
    if (errors.length < MAX_ERRORS_REPORTED) {
      const id = typeof (item as any)?.event_id === "string" ? (item as any).event_id : undefined;
      errors.push({
        index,
        ...(id ? { event_id: id } : {}),
        errors: parsed.error.issues.map((i) => ({
          field: i.path.length ? i.path.join(".") : "(event)",
          message: i.code === "unrecognized_keys" ? `unknown field(s): ${(i as any).keys.join(", ")}` : i.message,
        })),
      });
    }
  });

  let inserted: StoredEvent[] = [];
  if (valid.length > 0) {
    const res = await db.query(INSERT_SQL, [
      valid.map((e) => e.event_id),
      valid.map((e) => e.type),
      valid.map((e) => e.user_id),
      valid.map((e) => e.timestamp),
      valid.map((e) => JSON.stringify(e.properties)),
    ]);
    inserted = res.rows.map(rowToEvent);
  }

  return {
    summary: {
      received: items.length,
      accepted: inserted.length,
      duplicates: valid.length - inserted.length,
      rejected,
      errors,
    },
    inserted,
  };
}
