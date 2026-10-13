/**
 * A stand-in for uPlot under jsdom (which has no canvas). It records what the app asked the chart to draw: the
 * options (series, bands, point filters) and the aligned data (nulls are gaps), and lets a test move the cursor.
 */
export interface FakeOptions {
  width: number;
  height: number;
  series: Array<{ label?: string; stroke?: unknown; width?: number; spanGaps?: boolean; points?: { show?: boolean; filter?: number[] | null; size?: number } }>;
  bands?: Array<{ series: [number, number]; fill?: string }>;
  hooks?: { setCursor?: Array<(u: FakeUPlot) => void> };
  axes?: Array<{ label?: string; splits?: unknown; values?: unknown }>;
  scales?: Record<string, { time?: boolean; range?: unknown }>;
}

export class FakeUPlot {
  static instances: FakeUPlot[] = [];
  static reset() { FakeUPlot.instances = []; }
  cursor: { idx: number | null; left: number; top: number } = { idx: null, left: -10, top: -10 };
  destroyed = false;
  constructor(readonly opts: FakeOptions, readonly data: Array<ArrayLike<number | null>>, readonly host: HTMLElement) {
    FakeUPlot.instances.push(this);
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-fake-uplot", "true");
    host.appendChild(canvas);
  }
  setSize(): void { /* no layout in jsdom */ }
  valToPos(v: number): number { return v; }
  setCursor(c: { left: number; top: number }): void {
    this.cursor.left = c.left;
    this.cursor.top = c.top;
  }
  /** Test helper: hover day index `i` the way the library would report it. */
  hover(i: number | null): void {
    this.cursor.idx = i;
    for (const h of this.opts.hooks?.setCursor ?? []) h(this);
  }
  destroy(): void { this.destroyed = true; this.host.querySelectorAll("[data-fake-uplot]").forEach((n) => n.remove()); }
}
