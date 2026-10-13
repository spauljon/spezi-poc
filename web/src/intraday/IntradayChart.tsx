import { useEffect, useId, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { loadChartLibrary } from "../trends/library.ts";
import type { ChartTheme } from "../trends/plot.ts";
import { type DayModel, durationText, formatSample, gapText, hhmm, summarize } from "./model.ts";
import { buildIntradayPlot } from "./plot.ts";
import { revealing, type DayBounds, type View } from "./view.ts";

export interface IntradayChartProps {
  readonly model: DayModel;
  readonly display: string;
  readonly unit: string;
  readonly slot: number;
  /** Charts that share a key share their cursor. */
  readonly syncKey: string;
  readonly view: View | null;
  readonly onView: (view: View | null) => void;
  /** Words for a stored flag code (from the contract), so a marker is never an unexplained symbol. */
  readonly flagLabel: (code: string) => string;
  readonly busy?: boolean;
}

const HEIGHT = 220;

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

const sameView = (a: View | null, b: View | null) =>
  a === b || (a !== null && b !== null && Math.abs(a.min - b.min) < 0.5 && Math.abs(a.max - b.max) < 0.5);

export function IntradayChart({ model, display, unit, slot, syncKey, view, onView, flagLabel, busy = false }: IntradayChartProps) {
  const headingId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | null>(null);
  const sampleOf = useRef<readonly number[]>([]);
  const viewRef = useRef<View | null>(view);
  viewRef.current = view;
  const [active, setActive] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [drawFailed, setDrawFailed] = useState(false);
  const summary = useMemo(() => summarize(model, display, unit), [model, display, unit]);
  const bounds: DayBounds = useMemo(() => ({ start: model.windowStart / 1000, end: model.windowEnd / 1000 }), [model]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || model.n === 0) return;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let created: uPlot | undefined;
    setDrawFailed(false);
    void loadChartLibrary().then((UPlot) => {
      if (disposed) return;
      const plot = buildIntradayPlot(model, resolveTheme(host, slot), unit, display, syncKey, window.devicePixelRatio || 1);
      sampleOf.current = plot.sample;
      const u = new UPlot(
        {
          ...plot.options,
          width: Math.max(host.clientWidth, 280),
          height: HEIGHT,
          hooks: {
            ...plot.options.hooks,
            // open on the current window (a chart rebuilt while zoomed keeps it)
            ready: [(self: uPlot) => {
              const opening = viewRef.current;
              if (opening) self.setScale("x", opening);
            }],
            setCursor: [(self: uPlot) => setActive(self.cursor.idx ?? null)],
            // a drag-zoom on the canvas becomes the shared view (the other chart and the buttons follow it)
            setScale: [(self: uPlot, key: string) => {
              if (key !== "x") return;
              const min = self.scales.x?.min;
              const max = self.scales.x?.max;
              if (min === undefined || min === null || max === undefined || max === null) return;
              const next = { min, max };
              if (!sameView(viewRef.current, next)) onView(next);
            }],
          },
        } as uPlot.Options,
        plot.data,
        host,
      );
      created = u;
      chart.current = u;
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => u.setSize({ width: Math.max(host.clientWidth, 280), height: HEIGHT }));
        observer.observe(host);
      }
    }).catch(() => {
      if (!disposed) setDrawFailed(true);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      created?.destroy();
      chart.current = null;
    };
    // `onView` is stable from the page; the chart is rebuilt only when the data, colour slot or sync group change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, slot, unit, display, syncKey]);

  // the page's view (buttons, the other chart's zoom) drives this chart
  useEffect(() => {
    const u = chart.current;
    if (!u) return;
    const target = view ?? { min: bounds.start, max: bounds.end };
    if (u.scales.x?.min !== target.min || u.scales.x?.max !== target.max) u.setScale("x", target);
  }, [view, bounds]);

  const modelIndex = active === null ? -1 : (sampleOf.current[active] ?? -1);
  const stepTo = (i: number) => {
    const idx = Math.min(Math.max(i, 0), model.n - 1);
    const t = model.t[idx]! / 1000;
    const next = revealing(viewRef.current, t, bounds);
    if (!sameView(next, viewRef.current)) onView(next);
    const plotIdx = sampleOf.current.indexOf(idx);
    setActive(plotIdx >= 0 ? plotIdx : null);
    setKeyboard(true);
    const u = chart.current;
    if (u) u.setCursor({ left: u.valToPos(t, "x"), top: HEIGHT / 2 });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (model.n === 0) return;
    const here = modelIndex >= 0 ? modelIndex : e.key === "ArrowLeft" || e.key === "End" ? model.n : -1;
    switch (e.key) {
      case "ArrowRight": stepTo(here + 1); break;
      case "ArrowLeft": stepTo(here - 1); break;
      case "PageDown": stepTo(here + 60); break;
      case "PageUp": stepTo(here - 60); break;
      case "Home": stepTo(0); break;
      case "End": stepTo(model.n - 1); break;
      default: return;
    }
    e.preventDefault();
  };

  const flagWords = (i: number) => model.flagCodes[i]!.map(flagLabel).join(", ");
  const readout = modelIndex < 0
    ? "Hover the chart, or focus it and use the arrow keys (Page Up and Down for an hour at a time), to read a sample."
    : `${hhmm(model.t[modelIndex]!)}:${String(new Date(model.t[modelIndex]!).getUTCSeconds()).padStart(2, "0")} UTC: ${formatSample(model.v[modelIndex]!)} ${unit}${model.flagCodes[modelIndex]!.length > 0 ? ` (flagged: ${flagWords(modelIndex)})` : ""}`;

  return (
    <section className={`trend-card${busy ? " trend-busy" : ""}`} aria-labelledby={headingId} aria-busy={busy}>
      <h3 id={headingId}>
        <span className={`trend-key slot-${slot}`} aria-hidden="true" />
        {display} <span className="unit">({unit})</span>
      </h3>
      <p className="trend-summary">{summary}</p>
      {model.n > 0 && (
        <>
          <div
            className="trend-plot"
            tabIndex={0}
            role="group"
            aria-label={`${display} chart for ${model.day}. Use the left and right arrow keys to read one sample at a time.`}
            onKeyDown={onKeyDown}
            onBlur={() => setKeyboard(false)}
          >
            <div ref={hostRef} aria-hidden="true" />
          </div>
          <p className="intraday-key small muted">
            <span className="key-gap" aria-hidden="true" /> Gap: no samples for {durationText(model.gapThresholdMs)} or more
            {" · "}
            <span className="key-flag" aria-hidden="true">◇</span> Sample with a stored data-quality flag
          </p>
          <p className="trend-readout" aria-live={keyboard ? "polite" : "off"}>{readout}</p>
        </>
      )}
      {drawFailed && <p role="status" className="muted small">The chart could not be drawn in this browser. The tables below have the values.</p>}
      {model.n > 0 && (
        <>
          <details className="trend-table">
            <summary>Hourly table ({model.gaps.length} {model.gaps.length === 1 ? "gap" : "gaps"}, {model.flagged.length} flagged)</summary>
            <table className="values">
              <caption className="sr-only">{`${display} by UTC hour on ${model.day}`}</caption>
              <thead>
                <tr><th scope="col">Hour (UTC)</th><th scope="col">Samples</th><th scope="col">Min</th><th scope="col">Median</th><th scope="col">Max</th><th scope="col">Flagged</th></tr>
              </thead>
              <tbody>
                {model.hourly.map((h) => h.n === 0 ? (
                  <tr key={h.hour} className="no-data"><th scope="row">{String(h.hour).padStart(2, "0")}:00</th><td colSpan={5}>No data</td></tr>
                ) : (
                  <tr key={h.hour}>
                    <th scope="row">{String(h.hour).padStart(2, "0")}:00</th>
                    <td className="num">{h.n}</td>
                    <td className="num">{formatSample(h.min!)}</td>
                    <td className="num">{formatSample(h.median!)}</td>
                    <td className="num">{formatSample(h.max!)}</td>
                    <td className="num">{h.flagged}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          {model.gaps.length > 0 && (
            <details className="trend-table">
              <summary>Gaps ({model.gaps.length})</summary>
              <ul>{model.gaps.map((g) => <li key={g.start}>{gapText(g)}</li>)}</ul>
            </details>
          )}
          {model.flagged.length > 0 && (
            <details className="trend-table">
              <summary>Flagged samples ({model.flagged.length})</summary>
              <ul>
                {model.flagged.map((i) => (
                  <li key={i}>{hhmm(model.t[i]!)} UTC: {formatSample(model.v[i]!)} {unit}, {flagWords(i)}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
