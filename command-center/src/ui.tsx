import { NavLink, useNavigate } from "react-router-dom";
import { useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "./api";

const LINKS = [
  ["/", "Overview"],
  ["/map", "Map"],
  ["/inbox", "Inbox"],
  ["/groups", "Groups"],
  ["/teams", "Teams"],
  ["/connectivity", "Connectivity"],
  ["/unknown", "Unknown zones"],
  ["/alerts", "Alerts"],
  ["/review", "AI review"],
  ["/timeline", "Timeline"],
  ["/analytics", "Analytics"],
  ["/simulator", "Simulator"],
  ["/settings", "Settings"],
  ["/edge", "Edge"],
];

export function Banner() {
  return (
    <div className="banner">
      <span>PROTOTYPE — NOT A CERTIFIED EMERGENCY SERVICE. NO RESCUE IS GUARANTEED. SIMULATOR DATA IS NOT FIELD DATA.</span>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <>
      <Banner />
      <div className="shell">
        <nav className="nav" aria-label="Command center">
          <div className="word">DISASTERMESH</div>
          <p className="text-mute text-xs px-2 mb-3">Field desk · live records only</p>
          {LINKS.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              {label}
            </NavLink>
          ))}
          <button className="btn ghost mt-4 w-full" onClick={() => { setToken(null); navigate("/login"); }}>Sign out</button>
        </nav>
        <main className="main">{children}</main>
      </div>
    </>
  );
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api<T>(path)
      .then((value) => { if (!cancelled) { setData(value); setError(null); } })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, tick]);
  return { data, error, loading, reload: () => setTick((n) => n + 1) };
}

export function Guard({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => { if (!getToken()) navigate("/login"); }, [navigate]);
  if (!getToken()) return null;
  return <Shell>{children}</Shell>;
}

export function StateChip({ state }: { state: string }) {
  const cls = state === "need_help" ? "need" : state === "safe" ? "safe" : state === "evacuating" ? "evac" : "unknown";
  const label = state === "need_help" ? "NEED HELP" : state === "safe" ? "SELF-REPORTED SAFE" : state.replaceAll("_", " ").toUpperCase();
  return <span className={`chip ${cls}`}>{label}</span>;
}

export function Empty({ title, body }: { title: string; body: string }) {
  return <div className="empty panel"><h2 className="text-cream text-xl m-0">{title}</h2><p>{body}</p></div>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="grid gap-2" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="skel" />)}</div>;
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="err" role="alert">{error}</div>;
}

export function Confirm({ title, body, confirmLabel, onCancel, onConfirm }: { title: string; body: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="panel">
        <h2 className="mt-0">{title}</h2>
        <p>{body}</p>
        <div className="flex gap-2 justify-end">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function Bars({ rows }: { rows: { label: string; n: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (rows.length === 0) return <Empty title="No analytics yet" body="Charts appear only after stored records exist." />;
  return (
    <>
      <div className="bars" aria-hidden="true">
        {rows.map((row) => (
          <div className="bar" key={row.label}>
            <span>{row.label}</span>
            <i style={{ width: `${(row.n / max) * 100}%` }} />
            <b>{row.n}</b>
          </div>
        ))}
      </div>
      <table className="mt-4">
        <caption className="sr-only">Same figures as the chart</caption>
        <thead><tr><th>Label</th><th>Count</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.label}><td>{row.label}</td><td>{row.n}</td></tr>)}</tbody>
      </table>
    </>
  );
}
