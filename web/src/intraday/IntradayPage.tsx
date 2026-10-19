import { flagLabel as labelFlag } from "../flags.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import { explainError, type Explained } from "../explain.ts";
import { FhirClient } from "../fhir/client.ts";
import { dayHref, trendsHref, type DateRange } from "../route.ts";
import { todayUtc } from "../trends/model.ts";
import { IntradayChart } from "./IntradayChart.tsx";
import { loadDay } from "./load.ts";
import { type DayModel, nextDay, previousDay } from "./model.ts";
import { isWholeDay, pan, zoomHours, type View } from "./view.ts";

/** The metrics that have an intraday view: dense heart rate and HRV. (Resting heart rate is one value a day.) */
const INTRADAY_IDS = ["heartRate", "hrvSdnn"] as const;

type Load =
  | { readonly kind: "loading"; readonly loaded: number; readonly total: number | null }
  | { readonly kind: "ready"; readonly model: DayModel }
  | { readonly kind: "error"; readonly error: Explained };

export interface IntradayPageProps {
  readonly config: WebConfig;
  readonly contract: WebContract;
  readonly patientId: string;
  readonly day: string;
  /** Listed first when given (the metric the drill came from). */
  readonly metric: string | null;
  /** The trends range the drill came from, kept so "Back to trends" returns to it. */
  readonly range: DateRange | null;
  readonly now?: () => Date;
}

/** One UTC day of raw samples for heart rate and HRV on a shared, zoomable time axis. */
export function IntradayPage({ config, contract, patientId, day, metric, range, now = () => new Date() }: IntradayPageProps) {
  // only the (stable) token function: depending on the whole context would reload the day on any sign-in state change
  const { accessToken } = useAuth();
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [reloads, setReloads] = useState(0);
  const [view, setView] = useState<View | null>(null);
  const latest = useRef(0);

  const metrics = useMemo(() => {
    const picked = INTRADAY_IDS.flatMap((id) => {
      const index = contract.quantityMetrics.findIndex((m) => m.id === id);
      return index < 0 ? [] : [{ metric: contract.quantityMetrics[index]!, slot: index + 1 }];
    });
    return [...picked].sort((a, b) => Number(b.metric.id === metric) - Number(a.metric.id === metric));
  }, [contract, metric]);

  const today = todayUtc(now());
  const bounds = useMemo(() => {
    const start = Date.parse(`${day}T00:00:00Z`) / 1000;
    return { start, end: start + 86_400 };
  }, [day]);

  useEffect(() => {
    const ticket = ++latest.current;
    const cancelled = () => ticket !== latest.current;
    setView(null);
    setLoads(Object.fromEntries(metrics.map((m) => [m.metric.id, { kind: "loading", loaded: 0, total: null } as Load])));
    const client = new FhirClient(config.fhirBase, () => accessToken());
    for (const m of metrics) {
      loadDay(client, patientId, m.metric, contract, day, {
        now: now(),
        cancelled,
        onProgress: (loaded, total) => {
          if (!cancelled()) setLoads((prev) => ({ ...prev, [m.metric.id]: { kind: "loading", loaded, total } }));
        },
      }).then(
        (model) => { if (!cancelled()) setLoads((prev) => ({ ...prev, [m.metric.id]: { kind: "ready", model } })); },
        (error: unknown) => { if (!cancelled()) setLoads((prev) => ({ ...prev, [m.metric.id]: { kind: "error", error: explainError(error) } })); },
      );
    }
    // `now` is read once per load: a re-render must not restart a load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.fhirBase, accessToken, patientId, contract, day, metrics, reloads]);

  const flagLabel = useCallback((code: string) => labelFlag(contract, code), [contract])

  const day0 = { start: bounds.start, end: bounds.end };
  const whole = isWholeDay(view, day0);
  const firstMetric = metrics[0]?.metric.id ?? "heartRate";
  const first = metric ?? firstMetric;

  return (
    <section className="intraday" aria-labelledby="intraday-h">
      <p><a href={trendsHref(range)}>‹ Back to trends</a></p>
      <h2 id="intraday-h">Intraday: {day} (UTC)</h2>

      <div className="filters trend-filters">
        <div className="field-row" role="group" aria-label="Day">
          <a className="button-link" href={dayHref(previousDay(day), first, range)}>‹ Previous day</a>
          {day < today
            ? <a className="button-link" href={dayHref(nextDay(day), first, range)}>Next day ›</a>
            : <span className="muted small">This is the latest day.</span>}
        </div>
        <div className="field-row" role="group" aria-label="Zoom and pan">
          <button type="button" aria-pressed={whole} className={whole ? "pressed" : undefined} onClick={() => setView(null)}>Full day</button>
          <button type="button" onClick={() => setView(zoomHours(6, view, day0))}>6 hours</button>
          <button type="button" onClick={() => setView(zoomHours(1, view, day0))}>1 hour</button>
          <button type="button" disabled={whole} onClick={() => setView(pan(view, -1, day0))}>‹ Earlier</button>
          <button type="button" disabled={whole} onClick={() => setView(pan(view, 1, day0))}>Later ›</button>
          <button type="button" onClick={() => setReloads((n) => n + 1)}>Refresh</button>
        </div>
        <p className="muted small">
          Drag across a chart to zoom to that stretch; both charts follow. Times are UTC. A gap is a pause of ten minutes or
          more between samples (or ten times the day's usual interval, if longer); a marked sample carries a stored
          data-quality flag. Nothing is inferred from a value: an unusual value that nobody flagged is shown as it is.
        </p>
      </div>

      {metrics.map(({ metric: m, slot }) => {
        const load = loads[m.id];
        if (!load || load.kind === "loading") {
          const l = load?.kind === "loading" ? load : null;
          return (
            <p key={m.id} role="status" className="state">
              Loading {m.display}…{l && l.loaded > 0 ? ` ${l.loaded.toLocaleString("en-US")}${l.total !== null ? ` of ${l.total.toLocaleString("en-US")}` : ""} samples` : ""}
            </p>
          );
        }
        if (load.kind === "error") {
          return (
            <div key={m.id} role="alert" className="state state-error">
              <h3>{m.display}: {load.error.title}</h3>
              <p>{load.error.detail}</p>
              {load.error.retry && <button type="button" onClick={() => setReloads((n) => n + 1)}>Try again</button>}
            </div>
          );
        }
        return (
          <IntradayChart
            key={m.id}
            model={load.model}
            display={m.display}
            unit={m.unit}
            slot={slot}
            syncKey={`intraday-${day}`}
            view={view}
            onView={setView}
            flagLabel={flagLabel}
          />
        );
      })}
    </section>
  );
}
