import pg from "pg";

export type Db = pg.Pool;

export const DEFAULT_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/events";

export function createPool(connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS events (
  event_id    text PRIMARY KEY,                       -- the idempotency key
  type        text        NOT NULL,
  user_id     text        NOT NULL,
  ts          timestamptz NOT NULL,                   -- when the event happened (producer clock)
  properties  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()      -- when we stored it
);
CREATE INDEX IF NOT EXISTS events_ts_idx           ON events (ts);
CREATE INDEX IF NOT EXISTS events_type_ts_idx      ON events (type, ts);
CREATE INDEX IF NOT EXISTS events_user_type_ts_idx ON events (user_id, type, ts);  -- funnel joins
`;

export async function migrate(db: Db): Promise<void> {
  await db.query(MIGRATION);
}

/** Wait for Postgres to accept connections (useful when started alongside the DB container). */
export async function waitForDb(db: Db, attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
