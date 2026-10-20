import { useState } from "react";
import { formatValue } from "../format.ts";
import { UNLABELLED, mealOf, niceScale, readoutText, type DayCell } from "./model.ts";

const W = 900;
const H = 260;
const LEFT = 56;
const RIGHT = 10;
const TOP = 20;
const BOTTOM = 36;
const MAX_BAR = 26;
const VALUE_LABELS_UP_TO = 14;

export interface NutritionChartProps {
  readonly cells: readonly DayCell[];
  readonly label: string;
  readonly unit: string;
  /** The nutrient's colour slot (its position in the contract). */
  readonly slot: number;
  /** Stack each bar by meal. */
  readonly split: boolean;
  /** The meal buckets to stack, bottom to top. */
  readonly meals: readonly string[];
  readonly mealLabel: (meal: string) => string;
  /** The CSS class that colours a meal. */
  readonly mealClass: (meal: string) => string;
  readonly busy?: boolean;
}

const dayLabel = (day: string) => `${day.slice(5, 7)}-${day.slice(8, 10)}`;

/**
 * Daily totals as bars from 0. A day with entries is a bar (a total of 0 is a baseline mark and the figure 0); a day with
 * no entries is an empty slot with a hollow marker: never a bar, never a 0. Focus the chart and use the arrow keys to read a
 * day in words; every value is also in the table view.
 */
export function NutritionChart({ cells, label, unit, slot, split, meals, mealLabel, mealClass, busy = false }: NutritionChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const n = Math.max(cells.length, 1);
  const slotW = (W - LEFT - RIGHT) / n;
  const barW = Math.min(MAX_BAR, slotW * 0.7);
  const totals = cells.map((c) => (c.kind === "entries" ? c.total : 0));
  const scale = niceScale(Math.max(0, ...totals));
  const y = (v: number) => TOP + (1 - v / scale.max) * (H - TOP - BOTTOM);
  const base = y(0);
  const everyLabel = Math.max(1, Math.ceil(cells.length / 15));
  const showValues = cells.length <= VALUE_LABELS_UP_TO;

  const move = (to: number) => {
    setActive(Math.min(Math.max(to, 0), cells.length - 1));
    setKeyboard(true);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const here = active ?? (e.key === "ArrowLeft" || e.key === "End" ? cells.length : -1);
    switch (e.key) {
      case "ArrowRight": move(here + 1); break;
      case "ArrowLeft": move(here - 1); break;
      case "Home": move(0); break;
      case "End": move(cells.length - 1); break;
      default: return;
    }
    e.preventDefault();
  };
  const cell = active === null ? undefined : cells[active];

  return (
    <div className={busy ? "nutrition-busy" : undefined}>
      <div
        className="nutrition-plot"
        tabIndex={0}
        role="group"
        aria-label={`${label} chart. Use the left and right arrow keys to read one day at a time.`}
        onKeyDown={onKeyDown}
        onBlur={() => setKeyboard(false)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="presentation" focusable="false" aria-hidden="true" className="nutrition-chart">
          {scale.ticks.map((t) => (
            <g key={t}>
              <line x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} className="grid" />
              <text x={LEFT - 6} y={y(t) + 4} textAnchor="end" className="axis-label">{formatValue(t)}</text>
            </g>
          ))}
          {cells.map((c, i) => {
            const cx = LEFT + slotW * i + slotW / 2;
            return (
              <g key={c.day} data-day={c.day} data-kind={c.kind === "none" ? "none" : c.total === 0 ? "zero" : "entries"}>
                {i === active && <rect x={cx - slotW / 2} y={TOP} width={slotW} height={H - TOP - BOTTOM} className="active-col" />}
                <rect
                  x={cx - slotW / 2} y={TOP} width={slotW} height={H - TOP - BOTTOM} className="hit"
                  onMouseEnter={() => { setActive(i); setKeyboard(false); }}
                />
                {c.kind === "none" && <circle cx={cx} cy={base - 5} r={3.5} className="gap-dot" />}
                {c.kind === "entries" && c.total === 0 && (
                  <line x1={cx - barW / 2} x2={cx + barW / 2} y1={base - 1} y2={base - 1} className={`zero-mark slot-${slot}`} />
                )}
                {c.kind === "entries" && c.total > 0 && !split && (
                  <rect x={cx - barW / 2} y={y(c.total)} width={barW} height={Math.max(base - y(c.total), 0.5)} className={`nutrition-bar slot-${slot}`} />
                )}
                {c.kind === "entries" && c.total > 0 && split && (() => {
                  let acc = 0;
                  return meals.map((meal) => {
                    const part = mealOf(c, meal);
                    if (!part || part.total <= 0) return null;
                    const top = y(acc + part.total);
                    const h = y(acc) - top;
                    acc += part.total;
                    return <rect key={meal} x={cx - barW / 2} y={top} width={barW} height={Math.max(h - 1, 0.5)} className={`nutrition-bar meal ${mealClass(meal)}`} data-meal={meal} />;
                  });
                })()}
                {c.kind === "entries" && (c.artifactSuspected > 0 || c.lateArrival > 0) && (
                  <path
                    d={`M ${cx - 5} ${TOP - 4 + 9} L ${cx + 5} ${TOP - 4 + 9} L ${cx} ${TOP - 4} Z`} className="flag-mark" data-flag="true"
                  />
                )}
                {showValues && c.kind === "entries" && (
                  <text x={cx} y={y(c.total) - 5} textAnchor="middle" className="value-label">{formatValue(c.total)}</text>
                )}
                {i % everyLabel === 0 && <text x={cx} y={H - BOTTOM + 16} textAnchor="middle" className="axis-label">{dayLabel(c.day)}</text>}
              </g>
            );
          })}
          <text x={LEFT} y={H - 4} className="axis-label">{`Day as recorded (the date in each entry's own timestamp), month-day; ${unit}`}</text>
        </svg>
      </div>
      <ul className="nutrition-key small" aria-label="Key">
        {split && meals.map((m) => (
          <li key={m}><span className={`swatch ${mealClass(m)}`} aria-hidden="true" /> {mealLabel(m)}</li>
        ))}
        <li><svg width="14" height="10" aria-hidden="true"><circle cx="7" cy="5" r="3.5" className="gap-dot" /></svg> No entries (nothing recorded; not a total of 0)</li>
        <li><svg width="14" height="10" aria-hidden="true"><line x1="0" x2="14" y1="5" y2="5" className={`zero-mark slot-${slot}`} /></svg> Entries that add up to 0</li>
        {cells.some((c) => c.kind === "entries" && (c.artifactSuspected > 0 || c.lateArrival > 0)) && (
          <li><svg width="14" height="10" aria-hidden="true"><path d="M 2 9 L 12 9 L 7 1 Z" className="flag-mark" /></svg> Day includes a flagged entry (counted in the total; see the table)</li>
        )}
      </ul>
      <p className="trend-readout" aria-live={keyboard ? "polite" : "off"}>
        {cell === undefined
          ? "Hover the chart, or focus it and use the arrow keys, to read a day. The table below has every value."
          : readoutText(cell, label, unit, mealLabel)}
      </p>
    </div>
  );
}

export { UNLABELLED };
