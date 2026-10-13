import { useId, useMemo, useState } from "react";
import {
  LANE_ORDER, STAGE_LABEL, clockAt, clockNote, minutesText, offsetLabel, type Segment, type StageInterval,
} from "./model.ts";

const W = 900;
const LEFT = 132;
const RIGHT = 14;
const TOP = 14;
const LANE_H = 32;
const LANE_GAP = 8;
const AXIS_H = 34;

export interface HypnogramProps {
  readonly segments: readonly Segment[];
  readonly intervals: readonly StageInterval[];
  readonly label: string;
}

const hhmm = (ms: number, intervals: readonly StageInterval[]): string => {
  const c = clockAt(ms, intervals);
  if (c) return c.hhmm;
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
};

/** Hour ticks on the device's own clock: where the clock is known; "HH:MM UTC" where the data does not pin it down. */
function ticks(startMs: number, endMs: number, intervals: readonly StageInterval[]): number[] {
  const first = clockAt(startMs, intervals);
  const minute = first ? Number(first.hhmm.slice(3)) : 0;
  const stepMin = (endMs - startMs) / 3_600_000 > 14 ? 120 : 60;
  const out: number[] = [];
  for (let t = startMs + ((60 - minute) % 60) * 60_000; t <= endMs; t += stepMin * 60_000) out.push(t);
  return out;
}

/** One night as stage lanes: awake at the top, deepest sleep at the bottom, one bar per resolved stretch. */
export function Hypnogram({ segments, intervals, label }: HypnogramProps) {
  const descId = useId();
  const hatchId = `hatch-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const model = useMemo(() => {
    const startMs = segments[0]?.startMs ?? 0;
    const endMs = segments[segments.length - 1]?.endMs ?? 1;
    const present = new Set(segments.flatMap((s) => (s.stage ? [s.stage] : [])));
    const lanes = LANE_ORDER.filter((l) => l !== "asleepUnspecified" || present.has(l));
    return { startMs, endMs, lanes };
  }, [segments]);

  const { startMs, endMs, lanes } = model;
  const height = TOP + lanes.length * (LANE_H + LANE_GAP) + AXIS_H;
  const x = (ms: number) => LEFT + ((ms - startMs) / Math.max(1, endMs - startMs)) * (W - LEFT - RIGHT);
  const laneY = (stage: string) => TOP + lanes.indexOf(stage as (typeof LANE_ORDER)[number]) * (LANE_H + LANE_GAP);
  const note = useMemo(() => clockNote(intervals, startMs, endMs), [intervals, startMs, endMs]);

  const wording = (i: number): string => {
    const s = segments[i]!;
    const span = `${hhmm(s.startMs, intervals)} to ${hhmm(s.endMs, intervals)}`;
    const dur = minutesText((s.endMs - s.startMs) / 60_000);
    if (s.stage === null) return `${span}: no interval recorded, ${dur}`;
    const extra = s.covered > 1 ? `; ${s.covered} intervals overlap here and the one that starts later is shown` : "";
    return `${span}: ${STAGE_LABEL[s.stage] ?? s.stage}, ${dur}${extra}`;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = segments.length;
    if (n === 0) return;
    const here = active ?? (e.key === "ArrowLeft" || e.key === "End" ? n : -1);
    const next = e.key === "ArrowRight" ? here + 1 : e.key === "ArrowLeft" ? here - 1 : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next === null) return;
    setActive(Math.min(Math.max(next, 0), n - 1));
    e.preventDefault();
  };

  return (
    <figure className="hypnogram">
      <div
        className="hypno-focus"
        tabIndex={0}
        role="group"
        aria-label={`${label}. Use the left and right arrow keys to read one stretch at a time.`}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="presentation" focusable="false" aria-hidden="true">
          <defs>
            <pattern id={hatchId} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="7" className="hatch-line" />
            </pattern>
          </defs>
          {lanes.map((l) => (
            <g key={l}>
              <rect x={LEFT} y={laneY(l)} width={W - LEFT - RIGHT} height={LANE_H} className="lane-bg" />
              <text x={LEFT - 10} y={laneY(l) + LANE_H / 2 + 4} textAnchor="end" className="lane-label">{STAGE_LABEL[l] ?? l}</text>
            </g>
          ))}
          {segments.map((s, i) => {
            const x0 = x(s.startMs);
            const w = Math.max(x(s.endMs) - x0, 1.5);
            if (s.stage === null) {
              return (
                <rect key={i} x={x0} y={TOP} width={w} height={lanes.length * (LANE_H + LANE_GAP) - LANE_GAP}
                  fill={`url(#${hatchId})`} className={`unscored${active === i ? " active" : ""}`} />
              );
            }
            return (
              <g key={i}>
                <rect x={x0} y={laneY(s.stage)} width={w} height={LANE_H} rx={3}
                  className={`stage-bar stage-${s.stage}${active === i ? " active" : ""}`} />
                {s.covered > 1 && <rect x={x0} y={laneY(s.stage) - 5} width={w} height={3} className="overlap-mark" />}
              </g>
            );
          })}
          {segments.slice(1).map((s, i) => {
            const p = segments[i]!;
            if (p.stage === null || s.stage === null || p.endMs !== s.startMs || p.stage === s.stage) return null;
            const xs = x(s.startMs);
            return <line key={`c${i}`} x1={xs} x2={xs} y1={laneY(p.stage) + LANE_H / 2} y2={laneY(s.stage) + LANE_H / 2} className="connector" />;
          })}
          {ticks(startMs, endMs, intervals).map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={height - AXIS_H} y2={height - AXIS_H + 5} className="axis-tick" />
              <text x={x(t)} y={height - AXIS_H + 18} textAnchor="middle" className="axis-label">{hhmm(t, intervals)}</text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption id={descId} className="small muted">
        Clock times as recorded by the device ({note.offsets.length > 0 ? note.offsets.map(offsetLabel).join(", then ") : "offset unknown"}).
        {note.offsets.length > 1 && " The clock changed during this night; a time inside the interval that spans the change is shown in UTC."}
      </figcaption>
      <p className="trend-readout" aria-live={active === null ? "off" : "polite"}>
        {active === null ? "Focus the chart and use the arrow keys to read it stretch by stretch; the table below has every stretch." : wording(active)}
      </p>
      <ul className="stage-key small" aria-label="Key">
        {lanes.map((l) => (
          <li key={l}><span className={`swatch stage-${l}`} aria-hidden="true" /> {STAGE_LABEL[l]}</li>
        ))}
        <li><span className="swatch unscored-swatch" aria-hidden="true" /> No interval recorded</li>
        <li><span className="swatch overlap-swatch" aria-hidden="true" /> Overlap resolved (the later start is shown)</li>
      </ul>
      <details className="trend-table">
        <summary>Table view ({segments.length} stretches)</summary>
        <table className="values">
          <caption className="sr-only">{`${label}: stages in order`}</caption>
          <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Stage</th><th scope="col">Minutes</th><th scope="col">Note</th></tr></thead>
          <tbody>
            {segments.map((s, i) => (
              <tr key={i} className={s.stage === null ? "no-data" : undefined}>
                <th scope="row">{hhmm(s.startMs, intervals)}</th>
                <td>{hhmm(s.endMs, intervals)}</td>
                <td>{s.stage === null ? "No interval recorded" : STAGE_LABEL[s.stage] ?? s.stage}</td>
                <td className="num">{Math.round(((s.endMs - s.startMs) / 60_000) * 10) / 10}</td>
                <td>{s.covered > 1 ? "Overlap: the interval that starts later is shown" : s.stage === null ? "Not counted as sleep or wake" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
