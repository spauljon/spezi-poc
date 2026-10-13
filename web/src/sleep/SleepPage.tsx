import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import { explainError, type Explained } from "../explain.ts";
import { FhirClient } from "../fhir/client.ts";
import { sleepHref } from "../route.ts";
import { AnalyticsClient } from "../trends/client.ts";
import { addDays, daysBetween, todayUtc } from "../trends/model.ts";
import type { SleepResponse, SleepSession } from "./api.ts";
import { Hypnogram } from "./Hypnogram.tsx";
import { disagreement, loadNight, type NightModel } from "./load.ts";
import { STAGE_LABEL, clockAt, minutesText, nightSummary } from "./model.ts";
import { SleepSummaryChart, type NightRow } from "./SleepSummaryChart.tsx";

const PRESETS = [14, 30, 90] as const;
type Preset = (typeof PRESETS)[number];

type Load<T> =
  | { readonly kind: "loading"; readonly previous: T | null }
  | { readonly kind: "ready"; readonly value: T }
  | { readonly kind: "error"; readonly error: Explained };

export interface SleepPageProps {
  readonly config: WebConfig;
  readonly contract: WebContract;
  readonly patientId: string;
  /** The night (UTC date of the final waking) to open, and which of that date's sessions (by start, epoch seconds). */
  readonly night: string | null;
  readonly start: number | null;
  readonly now?: () => Date;
}

const startSeconds = (s: SleepSession) => Math.round(Date.parse(s.start) / 1000);
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–");

/** The multi-night summary from the analytic API, and one night's hypnogram from the stage intervals in HAPI. */
export function SleepPage({ config, contract, patientId, night, start, now = () => new Date() }: SleepPageProps) {
  const { accessToken } = useAuth();
  const [count, setCount] = useState<Preset>(30);
  const [reloads, setReloads] = useState(0);
  const [list, setList] = useState<Load<SleepResponse>>({ kind: "loading", previous: null });
  const [dayLoad, setDayLoad] = useState<Load<SleepResponse>>({ kind: "loading", previous: null });
  const [detail, setDetail] = useState<Load<NightModel>>({ kind: "loading", previous: null });
  const latestList = useRef(0);
  const latestDetail = useRef(0);

  const today = todayUtc(now());
  const range = { from: addDays(today, -(count - 1)), to: today };
  const analytics = useMemo(() => new AnalyticsClient(config.analyticsBase, () => accessToken()), [config.analyticsBase, accessToken]);
  const fhir = useMemo(() => new FhirClient(config.fhirBase, () => accessToken()), [config.fhirBase, accessToken]);

  useEffect(() => {
    const ticket = ++latestList.current;
    setList((p) => ({ kind: "loading", previous: p.kind === "ready" ? p.value : p.kind === "loading" ? p.previous : null }));
    analytics.sleep(patientId, range.from, range.to).then(
      (value) => { if (ticket === latestList.current) setList({ kind: "ready", value }); },
      (error: unknown) => { if (ticket === latestList.current) setList({ kind: "error", error: explainError(error) }); },
    );
    // `range` follows `count` and today's date; reloads is the Refresh button
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analytics, patientId, range.from, range.to, reloads]);

  // the selected night's sessions: its own one-day request, so a night outside the list's range still opens
  useEffect(() => {
    if (!night) return;
    let cancelled = false;
    setDayLoad({ kind: "loading", previous: null });
    analytics.sleep(patientId, night, night).then(
      (value) => { if (!cancelled) setDayLoad({ kind: "ready", value }); },
      (error: unknown) => { if (!cancelled) setDayLoad({ kind: "error", error: explainError(error) }); },
    );
    return () => { cancelled = true; };
  }, [analytics, patientId, night, reloads]);

  const sessionsOfNight = dayLoad.kind === "ready" ? dayLoad.value.sessions.filter((s) => s.night === night) : [];
  const chosen: SleepSession | null = night
    ? (start !== null ? sessionsOfNight.find((s) => startSeconds(s) === start) : undefined)
      ?? sessionsOfNight.find((s) => s.isMain) ?? sessionsOfNight[0] ?? null
    : null;

  useEffect(() => {
    if (!chosen) { setDetail({ kind: "loading", previous: null }); return; }
    const ticket = ++latestDetail.current;
    setDetail({ kind: "loading", previous: null });
    loadNight(fhir, patientId, contract, chosen, () => ticket !== latestDetail.current).then(
      (value) => { if (ticket === latestDetail.current) setDetail({ kind: "ready", value }); },
      (error: unknown) => { if (ticket === latestDetail.current) setDetail({ kind: "error", error: explainError(error) }); },
    );
    // keyed on the session's identity (start and revision), not the object, so a re-read of the list does not reload
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fhir, patientId, contract, chosen?.start, chosen?.end, chosen?.revision]);

  const shown = list.kind === "ready" ? list.value : list.kind === "loading" ? list.previous : null;
  const rows: NightRow[] = useMemo(() => {
    if (!shown) return [];
    return daysBetween(shown.from, shown.to).map((d) => {
      const day = shown.sessions.filter((s) => s.night === d);
      return { night: d, main: day.find((s) => s.isMain) ?? null, naps: day.filter((s) => !s.isMain) };
    });
  }, [shown]);

  return (
    <section className="sleep" aria-labelledby="sleep-h">
      <h2 id="sleep-h">Sleep</h2>

      <div className="filters trend-filters">
        <div role="group" aria-label="Nights shown" className="field-row">
          {PRESETS.map((d) => (
            <button key={d} type="button" aria-pressed={count === d} className={count === d ? "pressed" : undefined} onClick={() => setCount(d)}>
              {d} nights
            </button>
          ))}
          <button type="button" onClick={() => setReloads((n) => n + 1)}>Refresh</button>
        </div>
        <p className="muted small">
          {range.from} to {range.to}. A night is dated by the UTC date of the final waking from sleep, so for a patient far
          from UTC the date can differ from the calendar day they woke on. Clock times in a night are as the device recorded them.
          Light sleep is HealthKit's "core" sleep (a mapping decision of this project, contract A4).
        </p>
      </div>

      {list.kind === "error" && (
        <div role="alert" className="state state-error">
          <h3>{list.error.title}</h3>
          <p>{list.error.detail}</p>
          {list.error.retry && <button type="button" onClick={() => setReloads((n) => n + 1)}>Try again</button>}
        </div>
      )}
      {list.kind === "loading" && shown === null && <p role="status" className="state">Loading nights…</p>}
      {shown && shown.completeness.pendingWindows > 0 && (
        <p role="status" className="state">
          {shown.completeness.pendingWindows} window{shown.completeness.pendingWindows === 1 ? "" : "s"} changed and not yet recomputed: the latest nights may be out of date.
        </p>
      )}

      {shown && (
        <section className={`trend-card${list.kind === "loading" ? " trend-busy" : ""}`} aria-busy={list.kind === "loading"} aria-labelledby="nights-h">
          <h3 id="nights-h">Nights</h3>
          <p className="trend-summary">
            {rows.filter((r) => r.main).length} of {rows.length} nights have a recorded sleep
            {shown.completeness.missingDays.length > 0 ? `; ${shown.completeness.missingDays.length} have none (shown as empty slots, not estimated)` : ""}.
          </p>
          <SleepSummaryChart nights={rows} selected={night} href={(d) => sleepHref(d, null)} />
          <ul className="stage-key small" aria-label="Key">
            {(["asleepDeep", "asleepCore", "asleepREM", "asleepUnspecified", "awake"] as const).map((s) => (
              <li key={s}><span className={`swatch stage-${s}`} aria-hidden="true" /> {STAGE_LABEL[s]}</li>
            ))}
          </ul>
          <details className="trend-table">
            <summary>Table view</summary>
            <table className="values">
              <caption className="sr-only">Nightly sleep, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Night (UTC)</th><th scope="col">Asleep</th><th scope="col">Deep</th><th scope="col">Light</th><th scope="col">REM</th>
                  <th scope="col">Awake</th><th scope="col">Awakenings</th><th scope="col">To fall asleep</th><th scope="col">Naps</th><th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r) => r.main ? (
                  <tr key={r.night}>
                    <th scope="row">{r.night}</th>
                    <td className="num">{minutesText(r.main.asleepMin)}</td>
                    <td className="num">{pct(r.main.deepMin, r.main.asleepMin)}</td>
                    <td className="num">{pct(r.main.coreMin, r.main.asleepMin)}</td>
                    <td className="num">{pct(r.main.remMin, r.main.asleepMin)}</td>
                    <td className="num">{minutesText(r.main.awakeMin)}</td>
                    <td className="num">{r.main.awakenings}</td>
                    <td className="num">{minutesText(r.main.latencyMin)}</td>
                    <td>{r.naps.length === 0 ? "none" : r.naps.map((s) => minutesText(s.asleepMin)).join(", ")}</td>
                    <td><a href={sleepHref(r.night, null)}>Open</a></td>
                  </tr>
                ) : (
                  <tr key={r.night} className="no-data"><th scope="row">{r.night}</th><td colSpan={9}>No sleep recorded</td></tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">Stage columns are shares of the time asleep.</p>
          </details>
        </section>
      )}

      {night && (
        <section aria-labelledby="night-h" className="trend-card">
          <h3 id="night-h">Night of {night}</h3>
          <p><a href={sleepHref()}>‹ All nights</a></p>
          {dayLoad.kind === "loading" && <p role="status" className="state">Loading the night…</p>}
          {dayLoad.kind === "error" && (
            <div role="alert" className="state state-error"><h4>{dayLoad.error.title}</h4><p>{dayLoad.error.detail}</p></div>
          )}
          {dayLoad.kind === "ready" && sessionsOfNight.length === 0 && (
            <p className="state">No sleep is recorded for the night of {night}.</p>
          )}
          {sessionsOfNight.length > 1 && (
            <p className="small" role="group" aria-label="Sleep sessions on this date">
              {sessionsOfNight.map((s) => {
                const label = `${s.isMain ? "Main sleep" : "Nap"} (${minutesText(s.asleepMin)})`;
                return s === chosen
                  ? <strong key={s.start} className="session-choice">{label}</strong>
                  : <a key={s.start} className="session-choice" href={sleepHref(night, startSeconds(s))}>{label}</a>;
              })}
            </p>
          )}
          {chosen && detail.kind === "loading" && <p role="status" className="state">Loading the stage intervals…</p>}
          {chosen && detail.kind === "error" && (
            <div role="alert" className="state state-error">
              <h4>{detail.error.title}</h4><p>{detail.error.detail}</p>
              {detail.error.retry && <button type="button" onClick={() => setReloads((n) => n + 1)}>Try again</button>}
            </div>
          )}
          {chosen && detail.kind === "ready" && <NightDetail model={detail.value} session={chosen} />}
        </section>
      )}
    </section>
  );
}

function NightDetail({ model, session }: { model: NightModel; session: SleepSession }) {
  if (!model.stats || model.segments.length === 0) {
    return (
      <p role="alert" className="state state-error">
        The analytic summary lists this sleep, but no stage intervals could be read for it
        ({model.skipped.retracted + model.skipped.unknownStage + model.skipped.noPeriod + model.skipped.empty} left out). Nothing is drawn.
      </p>
    );
  }
  const diff = disagreement(model.stats, session);
  const left = [
    model.skipped.retracted > 0 ? `${model.skipped.retracted} retracted` : "",
    model.skipped.unknownStage > 0 ? `${model.skipped.unknownStage} with an unknown stage code` : "",
    model.skipped.noPeriod > 0 ? `${model.skipped.noPeriod} with no period` : "",
    model.skipped.empty > 0 ? `${model.skipped.empty} of no length` : "",
  ].filter(Boolean);
  const onset = clockAt(model.stats.onsetMs ?? model.stats.startMs, model.intervals);
  return (
    <>
      <p className="trend-summary">{nightSummary(model.stats, model.intervals, session.isMain)}</p>
      {diff && (
        <p role="alert" className="state state-error">
          The hypnogram and the analytic summary disagree on {diff.field}: the intervals give {Math.round(diff.web * 10) / 10}, the
          summary says {Math.round(diff.api * 10) / 10}. Treat both with care until the worker has recomputed this night.
        </p>
      )}
      {left.length > 0 && <p className="muted small">Left out of the picture: {left.join(", ")} Observation{left.length === 1 ? "" : "s"}.</p>}
      <Hypnogram
        segments={model.segments}
        intervals={model.intervals}
        label={`Hypnogram, ${session.isMain ? "night" : "nap"} ending ${session.night}${onset ? `, asleep from ${onset.hhmm}` : ""}`}
      />
    </>
  );
}
