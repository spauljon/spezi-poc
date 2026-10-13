import type uPlot from "uplot";
import { msToDay, type ChartData } from "./model.ts";

const HALF_DAY_S = 43_200;

/** Colours the canvas needs as strings (a canvas cannot read CSS variables). Resolved from the page's tokens. */
export interface ChartTheme {
  readonly series: string;
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly grid: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 06": a UTC day as the axis shows it. */
export function tickLabel(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Tick positions at UTC midnights, a whole number of days apart, wide enough for a label. uPlot's own time axis
 * places ticks in the browser's zone, which would move the labels off the UTC days the data is bucketed in.
 */
export function daySplits(minSec: number, maxSec: number, widthPx: number, minSpacePx = 64): number[] {
  const first = Math.ceil(minSec / 86_400) * 86_400;
  const spanDays = Math.max(1, (maxSec - minSec) / 86_400);
  const perDayPx = widthPx / spanDays;
  const steps = [1, 2, 3, 7, 14, 30, 60, 90, 180];
  const step = steps.find((s) => s * perDayPx >= minSpacePx) ?? 365;
  // anchor ticks on day numbers that are multiples of the step, so they do not shift as the range is moved by a day
  const anchored = Math.ceil(first / 86_400 / step) * step * 86_400;
  const out: number[] = [];
  for (let t = anchored; t <= maxSec; t += step * 86_400) out.push(t);
  return out;
}

export interface PlotSpec {
  readonly options: Omit<uPlot.Options, "width" | "height"> & { width?: number; height?: number };
  /** x, max, median, min: the order the series are declared in. */
  readonly data: uPlot.AlignedData;
}

/** A hex colour with an opacity, as the wash behind a line (the skill's "area fill ~10 to 15 percent"). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * The uPlot configuration for one metric. Everything that makes a gap a gap is here and asserted in tests:
 * `null` data points, `spanGaps: false`, and a marker on every isolated day so a single day cannot vanish.
 */
export function buildPlot(data: ChartData, theme: ChartTheme, unit: string, label: string): PlotSpec {
  const x = [...data.x];
  const toArr = (a: ReadonlyArray<number | null>) => [...a] as Array<number | null>;
  const aligned: uPlot.AlignedData = [x, toArr(data.max), toArr(data.median), toArr(data.min)];

  const allIdx = data.median.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  const markerIdx = data.pointsOnly ? allIdx : [...data.isolated];
  const seriesOpts = { spanGaps: false } as const;

  const options: PlotSpec["options"] = {
    legend: { show: false },
    padding: [12, 12, 0, 0],
    cursor: {
      drag: { x: false, y: false, setScale: false },
      x: true,
      y: false,
      // 8 px of fill inside a 2 px surface ring: the canvas strokes the ring centred on the edge of `size`
      points: { size: 12, width: 2, stroke: () => theme.surface, fill: () => theme.series },
    },
    scales: {
      x: {
        time: false,
        range: (_u, min, max) => [min - HALF_DAY_S, max + HALF_DAY_S],
      },
      y: {
        range: (_u, min, max) => {
          const span = Math.max(max - min, 1);
          return [min - span * 0.08, max + span * 0.08];
        },
      },
    },
    axes: [
      {
        stroke: theme.muted,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.grid, width: 1 },
        splits: (u, _i, min, max) => daySplits(min, max, u.bbox.width / devicePixelRatio),
        values: (_u, splits) => splits.map(tickLabel),
        font: "12px system-ui, sans-serif",
      },
      {
        stroke: theme.muted,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.grid, width: 1 },
        label: unit,
        labelFont: "12px system-ui, sans-serif",
        font: "12px system-ui, sans-serif",
        // one precision for the whole axis, from its step: 150, 100, 50 (not 150, 100, 50.0)
        values: (_u, splits) => {
          const step = splits.length > 1 ? Math.abs(splits[1]! - splits[0]!) : 1;
          const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
          return splits.map((v) => (decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals)));
        },
      },
    ],
    series: [
      {},
      // upper and lower edges: invisible lines (the wash between them is the range); present so the cursor can read them
      { label: `${label} max`, stroke: "transparent", width: 0, points: { show: false }, ...seriesOpts },
      {
        label: `${label} median`,
        stroke: theme.series,
        width: data.pointsOnly ? 0 : 2,
        points: {
          show: markerIdx.length > 0,
          filter: markerIdx,
          size: 12,
          width: 2,
          stroke: theme.surface,
          fill: theme.series,
        },
        ...seriesOpts,
      },
      { label: `${label} min`, stroke: "transparent", width: 0, points: { show: false }, ...seriesOpts },
    ],
    bands: data.pointsOnly ? [] : [{ series: [1, 3], fill: withAlpha(theme.series, 0.16) }],
  };
  return { options, data: aligned };
}

/** The day a cursor index stands for, or undefined when it points outside the data. */
export function dayAt(data: ChartData, idx: number | null | undefined): string | undefined {
  if (idx === null || idx === undefined) return undefined;
  return data.days[idx] ?? (data.x[idx] !== undefined ? msToDay(data.x[idx]! * 1000) : undefined);
}
