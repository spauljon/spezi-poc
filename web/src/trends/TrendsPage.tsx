import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import { explainError, type Explained } from "../explain.ts";
import { dayHref } from "../route.ts";
import { AnalyticsClient } from "./client.ts";
import {
  PRESETS, buildChartData, compareMetrics, presetRange, todayUtc, validateRange,
  type BandsResponse, type MetricMismatch, type RangePreset,
} from "./model.ts";
import { TrendChart } from "./TrendChart.tsx";

type Choice = RangePreset | "custom";
type Load =
  | { readonly kind: "loading"; readonly previous: readonly BandsResponse[] | null }
  | { readonly kind: "ready"; readonly results: readonly BandsResponse[] }
  | { readonly kind: "error"; readonly error: Explained };

export interface TrendsPageProps {
  readonly config: WebConfig;
  readonly contract: WebContract;
  readonly patientId: string;
  /** Injectable for tests; "today" is the UTC day the view ends on. */
  readonly now?: () => Date;
}

/** Daily min/median/max bands per metric from the analytic API: one filter row, stacked charts that share it. */
export function TrendsPage({ config, contract, patientId, now = () => new Date() }: TrendsPageProps) {
  const auth = useAuth();
  const [today, setToday] = useState(() => todayUtc(now()));
  const [choice, setChoice] = useState<Choice>(30);
  const initial = presetRange(30, today);
  const [customFrom, setCustomFrom] = useState(initial.from);
  const [customTo, setCustomTo] = useState(initial.to);
  const [load, setLoad] = useState<Load>({ kind: "loading", previous: null });
  const [reloads, setReloads] = useState(0);
  const [mismatches, setMismatches] = useState<readonly MetricMismatch[] | "unchecked" | null>(null);
  const latest = useRef(0);

  const range = choice === "custom" ? { from: customFrom, to: customTo } : presetRange(choice, today);
  const problem = choice === "custom" ? validateRange(range.from, range.to) : null;
  const client = useMemo(
    () => new AnalyticsClient(config.analyticsBase, () => auth.accessToken()),
    [config.analyticsBase, auth],
  );
  const metrics = contract.quantityMetrics;

  useEffect(() => {
    let cancelled = false;
    client.metrics().then(
      (api) => { if (!cancelled) setMismatches(compareMetrics(api.metrics, metrics)); },
      () => { if (!cancelled) setMismatches("unchecked"); },
    );
    return () => { cancelled = true; };
  }, [client, metrics]);

  useEffect(() => {
    if (problem !== null) return;
    const ticket = ++latest.current;
    setLoad((prev) => ({
      kind: "loading",
      previous: prev.kind === "ready" ? prev.results : prev.kind === "loading" ? prev.previous : null,
    }));
    Promise.all(metrics.map((m) => client.bands(patientId, m.id, range.from, range.to))).then(
      (results) => { if (ticket === latest.current) setLoad({ kind: "ready", results }); },
      (error: unknown) => { if (ticket === latest.current) setLoad({ kind: "error", error: explainError(error) }); },
    );
  }, [client, metrics, patientId, range.from, range.to, problem, reloads]);

  const refresh = useCallback(() => {
    setToday(todayUtc(now()));
    setReloads((n) => n + 1);
  }, [now]);

  const shown = load.kind === "ready" ? load.results : load.kind === "loading" ? load.previous : null;
  const busy = load.kind === "loading";
  const charts = useMemo(
    () => (shown ?? []).map((response) => ({ response, data: buildChartData(response) })),
    [shown],
  );
  const first = shown?.[0];
  const pending = Math.max(0, ...(shown ?? []).map((r) => r.completeness.pendingWindows));

  return (
    <section className="trends" aria-labelledby="trends-h">
      <h2 id="trends-h">Trends</h2>

      <div className="filters trend-filters">
        <div role="group" aria-label="Date range" className="field-row">
          {PRESETS.map((d) => (
            <button key={d} type="button" aria-pressed={choice === d} className={choice === d ? "pressed" : undefined} onClick={() => setChoice(d)}>
              {d} days
            </button>
          ))}
          <button type="button" aria-pressed={choice === "custom"} className={choice === "custom" ? "pressed" : undefined} onClick={() => setChoice("custom")}>
            Custom
          </button>
          <button type="button" onClick={refresh}>Refresh</button>
        </div>
        {choice === "custom" && (
          <div className="field-row">
            <label>From (UTC) <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /></label>
            <label>To (UTC) <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></label>
          </div>
        )}
        <p className="muted small">
          {problem ?? `Showing ${range.from} to ${range.to}. Days are UTC calendar days${first ? `: ${first.dayDefinition}` : ""}.`}
        </p>
      </div>

      {mismatches !== null && mismatches !== "unchecked" && mismatches.length > 0 && (
        <div role="alert" className="state state-error">
          <h3>The analytic service and this app disagree about the metrics</h3>
          <ul>{mismatches.map((m) => <li key={m.id}><strong>{m.id}</strong>: {m.problem}.</li>)}</ul>
        </div>
      )}
      {mismatches === "unchecked" && (
        <p className="muted small">The analytic service's metric list could not be checked against this app's contract.</p>
      )}
      {pending > 0 && (
        <p role="status" className="state">
          {pending} window{pending === 1 ? "" : "s"} changed and not yet recomputed: the most recent values may be out of date.
        </p>
      )}

      {load.kind === "error" && (
        <div role="alert" className="state state-error">
          <h3>{load.error.title}</h3>
          <p>{load.error.detail}</p>
          {load.error.retry && <button type="button" onClick={refresh}>Try again</button>}
        </div>
      )}
      {shown === null && load.kind === "loading" && problem === null && <p role="status" className="state">Loading trends…</p>}

      {shown !== null && problem === null && metrics.map((m, i) => {
        const chart = charts.find((c) => c.response.metric.id === m.id);
        if (!chart) return null;
        return (
          <TrendChart
            key={m.id}
            metric={chart.response.metric}
            data={chart.data}
            from={chart.response.from}
            to={chart.response.to}
            slot={i + 1}
            drillHref={(day) => dayHref(day, m.id)}
            busy={busy}
          />
        );
      })}
    </section>
  );
}
