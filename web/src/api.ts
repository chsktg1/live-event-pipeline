export interface StoredEvent {
  event_id: string;
  type: string;
  user_id: string;
  timestamp: string;
  properties: Record<string, unknown>;
}
export interface Summary { totalEvents: number; uniqueUsers: number; firstEventAt: string | null; lastEventAt: string | null }
export interface TypeCount { type: string; count: number }
export interface HourCount { hour: string; count: number }
export interface FunnelStep { step: string; users: number; conversionFromPrevious: number | null; conversionFromFirst: number | null }

export type RangeKey = "1h" | "24h" | "7d" | "all";
export const RANGES: Record<RangeKey, { label: string; ms: number | null }> = {
  "1h": { label: "Last hour", ms: 3_600_000 },
  "24h": { label: "Last 24h", ms: 86_400_000 },
  "7d": { label: "Last 7 days", ms: 7 * 86_400_000 },
  all: { label: "All time", ms: null },
};

async function get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
  const res = await fetch(`${path}${qs.size ? "?" + qs : ""}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.issues?.[0]?.message ?? body?.message ?? `HTTP ${res.status}`);
  return body as T;
}

export async function loadDashboard(range: RangeKey, steps: string) {
  const ms = RANGES[range].ms;
  const from = ms ? new Date(Date.now() - ms).toISOString() : undefined;
  const [summary, types, hours, funnel] = await Promise.all([
    get<Summary>("/stats/summary", { from }),
    get<{ types: TypeCount[] }>("/stats/by-type", { from }),
    get<{ hours: HourCount[] }>("/stats/by-hour", { from }),
    get<{ steps: FunnelStep[] }>("/stats/funnel", { from, steps }),
  ]);
  return { summary, types: types.types, hours: hours.hours, funnel: funnel.steps };
}

export const loadRecent = (limit = 30) => get<{ events: StoredEvent[] }>("/events/recent", { limit: String(limit) }).then((r) => r.events);
