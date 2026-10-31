import type { FunnelStep, HourCount, StoredEvent, TypeCount } from "./api";

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const color = (type: string) => `hsl(${hue(type)} 62% 48%)`;
const pct = (n: number | null) => (n === null ? "–" : `${(n * 100).toFixed(1)}%`);

export function TypeBars({ types }: { types: TypeCount[] }) {
  if (!types.length) return <Empty />;
  const max = Math.max(...types.map((t) => t.count));
  return (
    <ul className="bars">
      {types.map((t) => (
        <li key={t.type}>
          <span className="name">{t.type}</span>
          <span className="track">
            <span className="fill" style={{ width: `${(t.count / max) * 100}%`, background: color(t.type) }} />
          </span>
          <span className="num">{t.count.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

export function HourChart({ hours }: { hours: HourCount[] }) {
  if (!hours.length) return <Empty />;
  const W = 640, H = 200, PAD = { l: 36, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...hours.map((h) => h.count));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const bw = iw / hours.length;
  const every = Math.ceil(hours.length / 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Events per hour">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + ih * (1 - f)} y2={PAD.t + ih * (1 - f)} className="grid" />
          <text x={PAD.l - 6} y={PAD.t + ih * (1 - f) + 4} textAnchor="end" className="tick">{Math.round(max * f)}</text>
        </g>
      ))}
      {hours.map((h, i) => {
        const bh = (h.count / max) * ih;
        const d = new Date(h.hour);
        return (
          <g key={h.hour}>
            <rect x={PAD.l + i * bw + 1} y={PAD.t + ih - bh} width={Math.max(1, bw - 2)} height={bh} rx={2} className="bar">
              <title>{`${d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })}: ${h.count} events`}</title>
            </rect>
            {i % every === 0 && (
              <text x={PAD.l + i * bw + bw / 2} y={H - 6} textAnchor="middle" className="tick">
                {d.toLocaleTimeString([], { hour: "numeric" })}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function Funnel({ steps }: { steps: FunnelStep[] }) {
  if (!steps.length || steps[0]!.users === 0) return <Empty text="No users entered this funnel in the selected range." />;
  const top = steps[0]!.users;
  return (
    <ol className="funnel">
      {steps.map((s, i) => (
        <li key={s.step}>
          <div className="row">
            <span className="name">{s.step}</span>
            <span className="num">{s.users.toLocaleString()} users</span>
          </div>
          <div className="track">
            <span className="fill" style={{ width: `${(s.users / top) * 100}%`, background: color(s.step) }} />
          </div>
          {i > 0 && <div className="conv">{pct(s.conversionFromPrevious)} from {steps[i - 1]!.step} · {pct(s.conversionFromFirst)} overall</div>}
        </li>
      ))}
    </ol>
  );
}

export function LiveFeed({ events }: { events: StoredEvent[] }) {
  if (!events.length) return <Empty text="Waiting for events… run `npm run seed -- --live`." />;
  return (
    <ul className="feed">
      {events.map((e) => (
        <li key={e.event_id}>
          <time>{new Date(e.timestamp).toLocaleTimeString()}</time>
          <span className="pill" style={{ background: color(e.type) }}>{e.type}</span>
          <span className="user">{e.user_id}</span>
          <span className="props">{Object.keys(e.properties).length ? JSON.stringify(e.properties) : ""}</span>
        </li>
      ))}
    </ul>
  );
}

const Empty = ({ text = "No data in this range." }: { text?: string }) => <p className="empty">{text}</p>;
