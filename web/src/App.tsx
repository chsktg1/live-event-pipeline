import { useCallback, useEffect, useRef, useState } from "react";
import { loadDashboard, loadRecent, RANGES, type FunnelStep, type HourCount, type RangeKey, type StoredEvent, type Summary, type TypeCount } from "./api";
import { Funnel, HourChart, LiveFeed, TypeBars } from "./components";

const MAX_FEED = 50;
const DEFAULT_STEPS = "viewed,clicked,purchased";

interface Data { summary: Summary; types: TypeCount[]; hours: HourCount[]; funnel: FunnelStep[] }

export function App() {
  const [range, setRange] = useState<RangeKey>("24h");
  const [stepsInput, setStepsInput] = useState(DEFAULT_STEPS);
  const [steps, setSteps] = useState(DEFAULT_STEPS);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<StoredEvent[]>([]);
  const [live, setLive] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData(await loadDashboard(range, steps));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [range, steps]);

  // Always call the latest refresh from the long-lived EventSource handler.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 30_000); // keeps sliding windows ("last 24h") honest
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    loadRecent().then(setFeed).catch(() => {});
    const es = new EventSource("/events/stream");
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false); // EventSource reconnects on its own
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as StoredEvent;
      setFeed((f) => [e, ...f].slice(0, MAX_FEED));
      window.clearTimeout(timer.current); // debounce: one refresh per burst of events
      timer.current = window.setTimeout(() => refreshRef.current(), 800);
    };
    return () => es.close();
  }, []);

  const applySteps = (e: React.FormEvent) => {
    e.preventDefault();
    setSteps(stepsInput.replace(/\s+/g, ""));
  };

  return (
    <div className="page">
      <header>
        <h1>Live Event Pipeline</h1>
        <span className={`status ${live ? "on" : "off"}`}>{live ? "live" : "reconnecting…"}</span>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Time range">
          {(Object.keys(RANGES) as RangeKey[]).map((k) => (
            <button key={k} className={k === range ? "active" : ""} onClick={() => setRange(k)}>
              {RANGES[k].label}
            </button>
          ))}
        </div>
      </header>

      {error && <div className="error">Could not load data: {error}</div>}

      <section className="cards">
        <Card label="Events" value={data?.summary.totalEvents} />
        <Card label="Unique users" value={data?.summary.uniqueUsers} />
        <Card label="Event types" value={data?.types.length} />
        <Card label="Last event" text={data?.summary.lastEventAt ? new Date(data.summary.lastEventAt).toLocaleTimeString() : "–"} />
      </section>

      <main className="grid">
        <Panel title="Events by type">
          <TypeBars types={data?.types ?? []} />
        </Panel>
        <Panel title="Events per hour">
          <HourChart hours={data?.hours ?? []} />
        </Panel>
        <Panel
          title="Funnel"
          extra={
            <form onSubmit={applySteps} className="steps">
              <input value={stepsInput} onChange={(e) => setStepsInput(e.target.value)} aria-label="Funnel steps, comma separated" spellCheck={false} />
              <button type="submit">Apply</button>
            </form>
          }
        >
          <Funnel steps={data?.funnel ?? []} />
        </Panel>
        <Panel title="Live feed">
          <LiveFeed events={feed} />
        </Panel>
      </main>
    </div>
  );
}

function Card({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{text ?? (value === undefined ? "…" : value.toLocaleString())}</div>
    </div>
  );
}

function Panel({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}
