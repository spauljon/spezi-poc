import { STAGE_LABEL, minutesText } from "./model.ts";
import type { SleepSession } from "./api.ts";

const W = 900;
const H = 250;
const LEFT = 44;
const RIGHT = 10;
const TOP = 12;
const BOTTOM = 34;
const MAX_BAR = 24;

export interface NightRow {
  readonly night: string;
  readonly main: SleepSession | null;
  readonly naps: readonly SleepSession[];
}

export interface SleepSummaryChartProps {
  readonly nights: readonly NightRow[];
  readonly selected: string | null;
  readonly href: (night: string) => string;
}

/** Stack order from the baseline up: deep, light, REM, unspecified, then the awake time inside the night. */
const STACK: Array<{ stage: string; pick: (s: SleepSession) => number }> = [
  { stage: "asleepDeep", pick: (s) => s.deepMin },
  { stage: "asleepCore", pick: (s) => s.coreMin },
  { stage: "asleepREM", pick: (s) => s.remMin },
  { stage: "asleepUnspecified", pick: (s) => s.unspecifiedMin },
  { stage: "awake", pick: (s) => s.awakeMin },
];

const dayLabel = (night: string) => `${night.slice(5, 7)}-${night.slice(8, 10)}`;

/** Nightly stage minutes as stacked bars, a bar per night with a main sleep; a night without one is an empty slot. */
export function SleepSummaryChart({ nights, selected, href }: SleepSummaryChartProps) {
  const n = Math.max(nights.length, 1);
  const slot = (W - LEFT - RIGHT) / n;
  const barW = Math.min(MAX_BAR, slot * 0.7);
  const totals = nights.map((r) => (r.main ? STACK.reduce((t, s) => t + s.pick(r.main!), 0) : 0));
  const maxH = Math.max(8, Math.ceil(Math.max(0, ...totals) / 60 / 2) * 2);
  const y = (min: number) => TOP + (1 - min / 60 / maxH) * (H - TOP - BOTTOM);
  const gridHours = Array.from({ length: Math.floor(maxH / 2) + 1 }, (_, i) => i * 2);
  const everyLabel = Math.max(1, Math.ceil(nights.length / 15));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="presentation" focusable="false" className="sleep-summary">
      {gridHours.map((h) => (
        <g key={h}>
          <line x1={LEFT} x2={W - RIGHT} y1={y(h * 60)} y2={y(h * 60)} className="grid" />
          <text x={LEFT - 6} y={y(h * 60) + 4} textAnchor="end" className="axis-label">{h} h</text>
        </g>
      ))}
      {nights.map((r, i) => {
        const cx = LEFT + slot * i + slot / 2;
        const label = r.main
          ? `${r.night}: asleep ${minutesText(r.main.asleepMin)}; deep ${minutesText(r.main.deepMin)}, light ${minutesText(r.main.coreMin)}, REM ${minutesText(r.main.remMin)}; ${r.main.awakenings} awakenings${r.naps.length ? `; ${r.naps.length} nap${r.naps.length === 1 ? "" : "s"}` : ""}`
          : `${r.night}: no sleep recorded`;
        let acc = 0;
        return (
          <g key={r.night}>
            {r.main && (
              <a href={href(r.night)} aria-label={label} className={r.night === selected ? "bar-selected" : undefined}>
                <title>{label}</title>
                {/* a hit area wider than the bar */}
                <rect x={cx - slot / 2} y={TOP} width={slot} height={H - TOP - BOTTOM} className="hit" />
                {STACK.map(({ stage, pick }) => {
                  const m = pick(r.main!);
                  if (m <= 0) return null;
                  const top = y(acc + m);
                  const h = y(acc) - top;
                  acc += m;
                  return <rect key={stage} x={cx - barW / 2} y={top} width={barW} height={Math.max(h - 1, 0.5)} className={`stage-bar stage-${stage}`} />;
                })}
              </a>
            )}
            {i % everyLabel === 0 && (
              <text x={cx} y={H - BOTTOM + 16} textAnchor="middle" className={`axis-label${r.night === selected ? " selected-label" : ""}`}>{dayLabel(r.night)}</text>
            )}
          </g>
        );
      })}
      <text x={LEFT} y={H - 4} className="axis-label">Night (UTC date of the final waking), month-day</text>
    </svg>
  );
}

export { STAGE_LABEL };
