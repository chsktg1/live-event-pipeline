# live-event-pipeline

An event pipeline in TypeScript and Node: an **ingestion API** that validates and de-duplicates events into **Postgres**, **aggregation and funnel queries**, and a **React dashboard** that follows activity live as events arrive.

It is a small version of the core of a product-analytics backend (think Mixpanel): producers send events, the API stores each one exactly once, and the dashboard shows counts, a time series, a conversion funnel and a live feed.

<!-- Add a screenshot of the dashboard here: docs/dashboard.png -->

## Architecture

```
producers ──POST /events (one or a batch)──▶ validate each event (Zod) ──▶ Postgres
 (seed script, apps)                              │ bad ones rejected with        INSERT … ON CONFLICT (event_id)
                                                  │ field-level errors            DO NOTHING  ← idempotency
                                                  ▼
 React dashboard ◀── SSE live feed ◀── only newly stored events are broadcast
        └────────── GET /stats/* ──────▶ SQL aggregations (by type, by hour, ordered funnel)
```

1. **Validate at the edge.** Every event is checked against a strict schema; invalid ones are rejected with a useful error and never touch the database.
2. **Store idempotently.** `event_id` is the primary key and inserts use `ON CONFLICT DO NOTHING`, so retries, replays and concurrent duplicates leave exactly one row.
3. **Query with SQL.** Counts by type and hour and an ordered funnel run directly in Postgres, backed by composite indexes.
4. **Push live.** Only newly stored events are fanned out over Server-Sent Events (duplicates are not), so the dashboard never double-counts.
5. **One process.** The Fastify server also serves the built React app, so the whole thing is `docker compose up`.

## Quick start

**Docker (one command):**

```bash
docker compose up --build          # Postgres 17 + app on http://localhost:3000
docker compose exec app node dist/seed.js     # load ~1,000 events
# open http://localhost:3000
docker compose exec app node dist/seed.js --live   # stream events so the feed moves
```

**Local development:**

```bash
docker compose up db -d            # just Postgres
npm install && npm --prefix web install
npm run dev                        # API on :3000
npm run web:dev                    # dashboard on :5173 (proxies to the API)
npm run seed                       # ~1,000 events        (npm run seed -- --live to stream)
```

### Replay

The seed script uses fixed event ids. Run it again and every event is reported as a duplicate:

```
$ npm run seed
Sent 1000 events in 291ms: accepted=1000 duplicates=0 rejected=0
Re-sent the first 10 events: accepted=0 duplicates=10 (idempotency check)
$ npm run seed
Sent 1000 events in 166ms: accepted=0 duplicates=1000 rejected=0
```

Options: `--count 5000 --hours 72 --seed 7 --url http://host:3000 --batch 200`, and `--live --rate 4` for continuous streaming.

## API

### `POST /events`

Send one event object or an array (max 1,000). Event shape:

```json
{
  "event_id": "evt_8f3a91",
  "type": "purchased",
  "user_id": "u_42",
  "timestamp": "2026-11-01T14:03:22Z",
  "properties": { "sku": "team", "amount": 49.0 }
}
```

Rules: `type` is lowercase `[a-z][a-z0-9_.-]*` (max 64); `timestamp` is ISO 8601, not before 2000 and not more than 24h in the future; `properties` under 4 KB; unknown fields are rejected.

```bash
curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '[{"event_id":"a1","type":"viewed","user_id":"u1","timestamp":"2026-11-01T14:00:00Z"},
       {"event_id":"a2","type":"Bad Type","user_id":"u1","timestamp":"nope"}]'
```

```json
{ "received": 2, "accepted": 1, "duplicates": 0, "rejected": 1,
  "errors": [ { "index": 1, "event_id": "a2", "errors": [
      { "field": "type", "message": "must start with a lowercase letter and use only a-z, 0-9, '_', '.', '-' (max 64 chars)" },
      { "field": "timestamp", "message": "must be an ISO 8601 timestamp, e.g. 2026-11-01T14:03:22Z" } ] } ] }
```

Status codes: `200` all valid (new or duplicate) · `207` some rejected, the rest stored · `400` nothing valid / bad JSON / empty · `413` batch over 1,000.

### Queries

All accept optional `from` / `to` (ISO 8601; `to` is exclusive).

| Endpoint | Returns |
|---|---|
| `GET /stats/summary` | total events, unique users, first/last event time |
| `GET /stats/by-type` | `[{type, count}]`, most frequent first |
| `GET /stats/by-hour?type=` | `[{hour, count}]` in UTC, **empty hours filled with 0** |
| `GET /stats/funnel?steps=viewed,clicked,purchased&windowHours=` | users per step with conversion from previous and from first |
| `GET /events/recent?limit=50` | latest events |
| `GET /events/stream` | Server-Sent Events: one `data:` message per newly stored event |
| `GET /health` | `{status:"ok"}` (checks the database) |

**Funnel semantics.** A user reaches step N only if they did step N at or after the time they reached step N-1, using their earliest qualifying event at each step. So a purchase *before* the first click does not count, and repeated views count once. With `windowHours`, every step must also happen within that many hours of the user's first step. Steps must be distinct (2 to 6 of them).

## Tests

```bash
npm test            # 31 tests against a real Postgres
npm run typecheck
```

Tests run against a real Postgres, not a mock. If `TEST_DATABASE_URL` is set (CI, or the compose db) they use it; otherwise they boot a throwaway embedded Postgres 17, so `npm test` works with zero setup on a normal (non-root) account.

They cover: validation and error quality, mixed batches, **idempotency** (same event twice, repeated within a batch, 20 concurrent submissions, replaying a whole batch, retry with changed data keeps the first), the SSE feed (new events pushed, duplicates not), aggregation by type and hour (UTC bucketing, zero-fill, time ranges), funnel ordering, windows and edge cases, query-parameter validation, and the seed generator.

## What I'd change at real scale

Postgres handles this comfortably at demo volume. At roughly 100x, what breaks first and what I'd add:

- **Synchronous inserts on the request path.** Put a queue (Kafka, SQS or Redpanda) between ingestion and storage. Ingestion would validate, enqueue and return `202`; workers batch-insert. This also absorbs spikes and makes retries cheap. Idempotency on `event_id` stays exactly as is.
- **One big table and full-range scans.** Partition `events` by day (declarative partitioning) so queries prune partitions and old data can be dropped or archived by detaching a partition. Use BRIN on `ts` for the largest partitions.
- **Aggregations computed on every request.** Pre-aggregate: a rollup table or materialized view of counts per (hour, type), refreshed incrementally, and cached funnel results for common step sets. Move truly heavy, ad-hoc analytics to a columnar store (ClickHouse, BigQuery).
- **Live feed fan-out from one process.** SSE connections live in one Node process. With several instances, publish new events through Redis pub/sub or the queue so every instance can feed its own clients.
- **Dedup key growth.** The unique index on `event_id` grows without bound. With partitioning, enforce uniqueness per partition (include `ts` in the key) and accept a bounded dedup window, which is how most event systems do it.
- **Delivery semantics.** This is at-least-once in, effectively-once stored. Exactly-once end to end would need producer-side ids that are stable across retries, which is why `event_id` is required rather than generated by the server.

## Design notes

- **Why Server-Sent Events, not WebSockets?** The feed is one-way (server to browser). SSE is plain HTTP, reconnects automatically in the browser and needs no extra dependency.
- **Why Postgres aggregation instead of a streaming engine?** At this scale SQL over indexed data is simpler, exact and easy to test. A streaming engine (Flink, ksqlDB) earns its keep when latency or volume demands continuous computation.
- **Timestamps.** Producers' timestamps are stored as `timestamptz` (event time), separate from `received_at` (ingest time). Hour buckets are in UTC; the dashboard shows local time.
- **Bad batches don't poison good ones.** Each event is validated independently and the valid ones are stored in a single statement.

## Project layout

```
src/        schema.ts (contract) · ingest.ts · queries.ts · hub.ts (SSE) · app.ts (routes) · seed.ts · index.ts
web/        React + Vite dashboard (built into web/dist and served by the API)
test/       Vitest suites + embedded-Postgres global setup
```

## License

MIT
