import type uPlot from "uplot";
import { withAlpha, type ChartTheme } from "../trends/plot.ts";
import { type DayModel, hhmm } from "./model.ts";

const STEPS_S = [60, 300, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200];

/** Tick positions at UTC clock boundaries, at least `minSpacePx` apart: every minute up to every 12 hours. */
export function timeSplits(minSec: number, maxSec: number, widthPx: number, minSpacePx = 72): number[] {
  const span = Math.max(1, maxSec - minSec);
  const perSecond = widthPx / span;
  const step = STEPS_S.find((s) => s * perSecond >= minSpacePx) ?? 86_400;
  const first = Math.ceil(minSec / step) * step;
  const out: number[] = [];
  for (let t = first; t <= maxSec; t += step) out.push(t);
  return out;
}

/** "14:30" for a UTC instant given in Unix seconds. */
export const timeLabel = (seconds: number): string => hhmm(seconds * 1000);

export interface PlotSeries {
  /** x in Unix seconds, with a point inserted in every gap so that the line breaks there. */
  readonly x: number[];
  readonly y: Array<number | null>;
  /** For each plotted point, the index of its sample in the model, or -1 for a break inserted in a gap. */
  readonly sample: number[];
}

/**
 * The data uPlot is given. A line connects consecutive points, so a gap would be drawn as a straight segment
 * across it; a `null` in the middle of each gap makes the line stop (spanGaps is off). Nothing else is inserted.
 */
export function withGapBreaks(model: DayModel): PlotSeries {
  const x: number[] = [];
  const y: Array<number | null> = [];
  const sample: number[] = [];
  // Value-less anchors at both ends of the window make the library's automatic x extent the whole day, so a day that
  // starts or ends with a gap is drawn as such and "full day" is a real extent rather than "first to last sample".
  const first = model.t[0];
  if (first === undefined || first > model.windowStart) {
    x.push(model.windowStart / 1000);
    y.push(null);
    sample.push(-1);
  }
  for (let i = 0; i < model.t.length; i++) {
    const here = model.t[i]!;
    const prev = i > 0 ? model.t[i - 1]! : null;
    if (prev !== null && here - prev > model.gapThresholdMs) {
      x.push((prev + here) / 2000);
      y.push(null);
      sample.push(-1);
    }
    x.push(here / 1000);
    y.push(model.v[i]!);
    sample.push(i);
  }
  const last = model.t[model.t.length - 1];
  if (last === undefined || last < model.windowEnd) {
    x.push(model.windowEnd / 1000);
    y.push(null);
    sample.push(-1);
  }
  return { x, y, sample };
}

/** The parts of a canvas and a uPlot the overlays need, so they can be driven by a stand-in in tests. */
export interface PaintTarget {
  readonly ctx: Pick<CanvasRenderingContext2D, "save" | "restore" | "beginPath" | "rect" | "clip" | "fillRect" | "moveTo" | "lineTo" | "closePath" | "fill" | "stroke" | "fillStyle" | "strokeStyle" | "lineWidth">;
  readonly bbox: { left: number; top: number; width: number; height: number };
  valToPos(value: number, scale: string, canvasPixels?: boolean): number;
}

/** Shaded gaps behind the line (call from `drawAxes`: after the grid, before the series). */
export function paintGaps(u: PaintTarget, model: DayModel, theme: ChartTheme): void {
  const { ctx, bbox } = u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.fillStyle = withAlpha(theme.muted, 0.22);
  for (const g of model.gaps) {
    const x0 = u.valToPos(g.start / 1000, "x", true);
    const x1 = u.valToPos(g.end / 1000, "x", true);
    ctx.fillRect(Math.min(x0, x1), bbox.top, Math.abs(x1 - x0), bbox.height);
  }
  ctx.restore();
}

/**
 * A diamond outline on every sample that carries a stored flag (call from `draw`: over the series). A shape, not a
 * colour, so it survives colour-blindness and print; `ratio` is the device pixel ratio.
 */
export function paintFlagged(u: PaintTarget, model: DayModel, theme: ChartTheme, ratio = 1): void {
  const { ctx, bbox } = u;
  const r = 7 * ratio;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.lineWidth = 2 * ratio;
  ctx.strokeStyle = theme.ink;
  ctx.fillStyle = theme.surface;
  for (const i of model.flagged) {
    const x = u.valToPos(model.t[i]! / 1000, "x", true);
    const y = u.valToPos(model.v[i]!, "y", true);
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export interface IntradayPlot {
  /** Plotted point index to model sample index (-1 for a break). */
  readonly sample: readonly number[];
  readonly options: Omit<uPlot.Options, "width" | "height"> & { width?: number; height?: number };
  readonly data: uPlot.AlignedData;
}

export function buildIntradayPlot(
  model: DayModel,
  theme: ChartTheme,
  unit: string,
  label: string,
  syncKey: string,
  ratio = 1,
): IntradayPlot {
  const s = withGapBreaks(model);
  const options: IntradayPlot["options"] = {
    legend: { show: false },
    padding: [12, 12, 0, 0],
    cursor: {
      drag: { x: true, y: false, setScale: true },
      x: true,
      y: false,
      sync: { key: syncKey, setSeries: false },
      points: { size: 10, width: 2, stroke: () => theme.surface, fill: () => theme.series },
    },
    scales: {
      // An ordinary automatic x scale: it spans the anchors (the whole day) and zooms. A static `range` array is
      // returned for EVERY zoom request, and a `range` function that ignores its inputs does the same.
      x: { time: false },
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
        splits: (u, _i, min, max) => timeSplits(min, max, u.bbox.width / devicePixelRatio),
        values: (_u, splits) => splits.map(timeLabel),
        font: "12px system-ui, sans-serif",
      },
      {
        stroke: theme.muted,
        grid: { stroke: theme.grid, width: 1 },
        ticks: { stroke: theme.grid, width: 1 },
        label: unit,
        labelFont: "12px system-ui, sans-serif",
        font: "12px system-ui, sans-serif",
        values: (_u, splits) => {
          const step = splits.length > 1 ? Math.abs(splits[1]! - splits[0]!) : 1;
          const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
          return splits.map((v) => (decimals === 0 ? String(Math.round(v)) : v.toFixed(decimals)));
        },
      },
    ],
    series: [
      {},
      {
        label,
        stroke: theme.series,
        width: 1.5,
        spanGaps: false,
        // points appear by themselves once zoomed in far enough that raw samples are further apart than their size
        points: { show: true, size: 6, width: 0, fill: theme.series, space: 14 },
      },
    ],
    hooks: {
      drawAxes: [(u) => paintGaps(u as unknown as PaintTarget, model, theme)],
      draw: [(u) => paintFlagged(u as unknown as PaintTarget, model, theme, ratio)],
    },
  };
  return { options, data: [s.x, s.y], sample: s.sample };
}
