import { useEffect, useId, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { flagNotice, formatValue, summarize, type ChartData, type MetricInfo } from "./model.ts";
import { loadChartLibrary } from "./library.ts";
import { buildPlot, dayAt, type ChartTheme } from "./plot.ts";

export interface TrendChartProps {
  readonly metric: MetricInfo;
  readonly data: ChartData;
  readonly from: string;
  readonly to: string;
  /** The categorical slot (1 to 8) this metric always wears: by its place in the contract, never by rank. */
  readonly slot: number;
  /** Where "Intraday" for a day leads. */
  readonly drillHref: (day: string) => string;
  /** The previous answer is held, dimmed, while a new one loads. */
  readonly busy?: boolean;
}

const HEIGHT = 190;

function resolveTheme(el: Element, slot: number): ChartTheme {
  const css = getComputedStyle(el);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    series: get(`--viz-${slot}`, "#2a78d6"),
    surface: get("--viz-surface", "#fcfcfb"),
    ink: get("--viz-ink", "#0b0b0b"),
    muted: get("--viz-muted", "#898781"),
    grid: get("--viz-grid", "#e1e0d9"),
  };
}

/** True when the OS asks for dark: the canvas colours are re-resolved when it flips. */
function useColourScheme(): string {
  const [scheme, setScheme] = useState(() => (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setScheme(query.matches ? "dark" : "light");
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return scheme;
}

/** ", of which 2 flagged as suspected artifacts and 1 late" for one day, or nothing. */
function flagsOf(data: ChartData, i: number): string {
  const bits: string[] = [];
  const artifact = data.artifact[i] ?? 0;
  const late = data.late[i] ?? 0;
  if (artifact > 0) bits.push(`${artifact} flagged as suspected ${artifact === 1 ? "artifact" : "artifacts"}`);
  if (late > 0) bits.push(`${late} flagged late`);
  return bits.length === 0 ? "" : `, of which ${bits.join(" and ")}`;
}

export function TrendChart({ metric, data, from, to, slot, drillHref, busy = false }: TrendChartProps) {
  const headingId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [drawFailed, setDrawFailed] = useState(false);
  const scheme = useColourScheme();
  const summary = useMemo(() => summarize(metric, data, from, to), [metric, data, from, to]);
  const notice = useMemo(() => flagNotice(data), [data]);

  useEffect(() => {
    const host = plotRef.current;
    if (!host) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let created: uPlot | undefined;
    setDrawFailed(false);
    // Loaded on demand: the charting code is not part of the sign-in page, and it needs a browser (matchMedia).
    void loadChartLibrary().then((UPlot) => {
      if (disposed) return;
      const theme = resolveTheme(host, slot);
      const spec = buildPlot(data, theme, metric.unit, metric.display);
      const u = new UPlot(
        {
          ...spec.options,
          width: Math.max(host.clientWidth, 280),
          height: HEIGHT,
          hooks: { setCursor: [(self: uPlot) => setActive(self.cursor.idx ?? null)] },
        } as uPlot.Options,
        spec.data,
        host,
      );
      created = u;
      chart.current = u;
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => u.setSize({ width: Math.max(host.clientWidth, 280), height: HEIGHT }));
        observer.observe(host);
      }
    }).catch(() => {
      // The values are all in the table below; say so rather than leave a blank box.
      if (!disposed) setDrawFailed(true);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      created?.destroy();
      chart.current = null;
    };
  }, [data, metric, slot, scheme]);

  const move = (to: number) => {
    const u = chart.current;
    const idx = Math.min(Math.max(to, 0), data.days.length - 1);
    setActive(idx);
    setKeyboard(true);
    if (u) {
      const left = u.valToPos(data.x[idx]!, "x");
      u.setCursor({ left, top: HEIGHT / 2 });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const here = active ?? (e.key === "ArrowLeft" || e.key === "End" ? data.days.length : -1);
    switch (e.key) {
      case "ArrowRight": move(here + 1); break;
      case "ArrowLeft": move(here - 1); break;
      case "Home": move(0); break;
      case "End": move(data.days.length - 1); break;
      default: return;
    }
    e.preventDefault();
  };

  const day = dayAt(data, active);
  const idx = active ?? -1;
  const med = idx >= 0 ? data.median[idx] : null;

  return (
    <section className={`trend-card${busy ? " trend-busy" : ""}`} aria-labelledby={headingId} aria-busy={busy}>
      <h3 id={headingId}>
        <span className={`trend-key slot-${slot}`} aria-hidden="true" />
        {metric.display} <span className="unit">({metric.unit})</span>
      </h3>
      <p className="trend-summary">{summary}</p>
      {notice && <p className="trend-flags"><span aria-hidden="true">⚠ </span><strong>Data quality:</strong> {notice}</p>}
      <div
        className="trend-plot"
        tabIndex={0}
        role="group"
        aria-label={`${metric.display} chart. Use the left and right arrow keys to read one day at a time.`}
        onKeyDown={onKeyDown}
        onBlur={() => setKeyboard(false)}
      >
        <div ref={plotRef} aria-hidden="true" />
      </div>
      {drawFailed && (
        <p role="status" className="muted small">The chart could not be drawn in this browser. Every value is in the table view below.</p>
      )}
      <p className="trend-readout" aria-live={keyboard ? "polite" : "off"}>
        {day === undefined
          ? "Hover the chart, or focus it and use the arrow keys, to read a day. The table below has every value."
          : med === null || med === undefined
            ? `${day}: no data (a gap, not an estimate).`
            : data.pointsOnly
              ? `${day}: ${formatValue(med)} ${metric.unit}.`
              : `${day}: median ${formatValue(med)}, range ${formatValue(data.min[idx]!)} to ${formatValue(data.max[idx]!)} ${metric.unit}, from ${data.n[idx]} samples${flagsOf(data, idx)}.`}
      </p>
      <details className="trend-table">
        <summary>Table view</summary>
        <table className="values">
          <caption className="sr-only">{`${metric.display} by UTC day`}</caption>
          <thead>
            <tr><th scope="col">Day (UTC)</th><th scope="col">Samples</th><th scope="col">Min</th><th scope="col">Median</th><th scope="col">Max</th><th scope="col">Flagged</th><th scope="col">Late</th><th scope="col">Intraday</th></tr>
          </thead>
          <tbody>
            {data.days.map((d, i) => {
              const m = data.median[i];
              if (m === null || m === undefined) {
                return (
                  <tr key={d} className="no-data"><th scope="row">{d}</th><td colSpan={7}>No data</td></tr>
                );
              }
              return (
                <tr key={d}>
                  <th scope="row">{d}</th>
                  <td className="num">{data.n[i]}</td>
                  <td className="num">{formatValue(data.min[i]!)}</td>
                  <td className="num">{formatValue(m)}</td>
                  <td className="num">{formatValue(data.max[i]!)}</td>
                  <td className="num">{data.artifact[i]! > 0 ? <strong><span aria-hidden="true">⚠ </span>{data.artifact[i]}</strong> : data.artifact[i]}</td>
                  <td className="num">{data.late[i]}</td>
                  <td><a href={drillHref(d)}>Intraday</a></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </section>
  );
}
