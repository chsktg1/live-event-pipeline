import { z } from "zod";

const MIN_TS = Date.parse("2000-01-01T00:00:00Z");
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const MAX_PROPERTIES_BYTES = 4096;

export const TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const typeName = z
  .string()
  .regex(TYPE_PATTERN, "must start with a lowercase letter and use only a-z, 0-9, '_', '.', '-' (max 64 chars)");

/** The contract for one event. Anything that does not match is rejected at the edge. */
export const eventSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    type: typeName,
    user_id: z.string().min(1).max(128),
    timestamp: z.iso
      .datetime({ offset: true, message: "must be an ISO 8601 timestamp, e.g. 2026-11-01T14:03:22Z" })
      .refine((s) => !Number.isFinite(Date.parse(s)) || Date.parse(s) >= MIN_TS, "must be on or after 2000-01-01")
      .refine((s) => !Number.isFinite(Date.parse(s)) || Date.parse(s) <= Date.now() + MAX_FUTURE_MS, "must not be more than 24h in the future"),
    properties: z
      .record(z.string(), z.unknown())
      .default({})
      .refine((p) => JSON.stringify(p).length <= MAX_PROPERTIES_BYTES, `properties must be under ${MAX_PROPERTIES_BYTES} bytes`),
  })
  .strict();

export type EventInput = z.infer<typeof eventSchema>;

export interface StoredEvent {
  event_id: string;
  type: string;
  user_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

// ---- query-string schemas -------------------------------------------------

const isoOpt = z.iso.datetime({ offset: true }).optional();

export const rangeQuery = z.object({ from: isoOpt, to: isoOpt });

export const byHourQuery = rangeQuery.extend({ type: typeName.optional() });

export const recentQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export const funnelQuery = rangeQuery.extend({
  steps: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(
      z
        .array(typeName)
        .min(2, "a funnel needs at least 2 steps")
        .max(6, "a funnel supports at most 6 steps")
        .refine((a) => new Set(a).size === a.length, "steps must be distinct"),
    ),
  windowHours: z.coerce.number().positive().max(24 * 365).optional(),
});
