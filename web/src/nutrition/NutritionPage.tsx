import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import { explainError, type Explained } from "../explain.ts";
import { formatInstantUtc, formatValue } from "../format.ts";
import { nutritionHref } from "../route.ts";
import { AnalyticsClient } from "../trends/client.ts";
import { addDays, daysBetween, todayUtc } from "../trends/model.ts";
import type { NutritionResponse } from "./api.ts";
import { NutritionChart } from "./NutritionChart.tsx";
import {
  KCAL_PER_GRAM, MACRO_IDS, UNLABELLED, buildCells, flagsNotice, macroRows, mealKeys, mealOf, summaryText,
  type DayCell,
} from "./model.ts";

const PRESETS = [7, 14, 30, 90] as const;
type Preset = (typeof PRESETS)[number];

type Load =
  | { readonly kind: "loading"; readonly previous: ReadonlyMap<string, NutritionResponse> | null }
  | { readonly kind: "ready"; readonly results: ReadonlyMap<string, NutritionResponse> }
  | { readonly kind: "error"; readonly error: Explained };

export interface NutritionPageProps {
  readonly config: WebConfig;
  readonly contract: WebContract;
  readonly patientId: string;
  /** The nutrient to open on (a contract id); null for the first one the contract lists. */
  readonly nutrient: string | null;
  readonly now?: () => Date;
}

/** Daily dietary totals from the analytic API, by day as recorded: one nutrient in detail, and energy with the macronutrients. */
export function NutritionPage({ config, contract, patientId, nutrient: routeNutrient, now = () => new Date() }: NutritionPageProps) {
  const { accessToken } = useAuth();
  const metrics = contract.intakeMetrics;
  const [count, setCount] = useState<Preset>(30);
  const [chosen, setChosen] = useState<string | null>(routeNutrient);
  const [split, setSplit] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [today, setToday] = useState(() => todayUtc(now()));
  const [load, setLoad] = useState<Load>({ kind: "loading", previous: null });
  const latest = useRef(0);
  /** Whose totals are on screen: another patient's must never stay up while this one's load (the data-set switch). */
  const shownFor = useRef(patientId);

  const selected = metrics.find((m) => m.id === chosen) ?? metrics[0];
  const range = { from: addDays(today, -(count - 1)), to: today };
  const client = useMemo(() => new AnalyticsClient(config.analyticsBase, () => accessToken()), [config.analyticsBase, accessToken]);
  // the selected nutrient, and the four the energy and macronutrient table needs
  const wanted = useMemo(() => {
    const ids = [selected?.id, ...Object.values(MACRO_IDS)].filter((id): id is string => !!id && metrics.some((m) => m.id === id));
    return [...new Set(ids)];
  }, [selected?.id, metrics]);

  useEffect(() => {
    if (wanted.length === 0) return;
    const ticket = ++latest.current;
    const sameOwner = shownFor.current === patientId;
    shownFor.current = patientId;
    setLoad((prev) => ({
      kind: "loading",
      previous: !sameOwner ? null : prev.kind === "ready" ? prev.results : prev.kind === "loading" ? prev.previous : null,
    }));
    Promise.all(wanted.map((id) => client.nutrition(patientId, id, range.from, range.to))).then(
      (results) => { if (ticket === latest.current) setLoad({ kind: "ready", results: new Map(results.map((r) => [r.nutrient.id, r])) }); },
      (error: unknown) => { if (ticket === latest.current) setLoad({ kind: "error", error: explainError(error) }); },
    );
  }, [client, patientId, wanted, range.from, range.to, reloads]);

  // keep the address in step with the nutrient, so a reload returns to the same view
  useEffect(() => {
    if (selected && typeof window !== "undefined") {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nutritionHref(selected.id)}`);
    }
  }, [selected]);

  const refresh = () => {
    setToday(todayUtc(now()));
    setReloads((n) => n + 1);
  };

  if (!selected) {
    return (
      <section className="nutrition" aria-labelledby="nutrition-h">
        <h2 id="nutrition-h">Nutrition</h2>
        <p role="alert" className="state state-error">This app's contract has no dietary intake metrics (contract 1.5.0 or later is required).</p>
      </section>
    );
  }

  const shown = load.kind === "ready" ? load.results : load.kind === "loading" ? load.previous : null;
  const busy = load.kind === "loading";
  const days = daysBetween(range.from, range.to);
  const main = shown?.get(selected.id);
  const cells = main ? buildCells(main) : null;
  const slot = metrics.findIndex((m) => m.id === selected.id) + 1;
  const contractMeals = contract.mealTypes.map((m) => m.code);
  const mealLabel = (meal: string) =>
    meal === UNLABELLED ? "No meal recorded" : contract.mealTypes.find((m) => m.code === meal)?.display ?? meal;
  const mealClass = (meal: string) => {
    const i = contractMeals.indexOf(meal);
    return meal === UNLABELLED || i < 0 ? "meal-none" : `meal-slot-${i + 1}`;
  };
  const meals = cells ? mealKeys(cells, contractMeals) : [];
  const pending = Math.max(0, ...[...(shown?.values() ?? [])].map((r) => r.completeness.pendingWindows));
  const notice = cells ? flagsNotice(cells) : null;
  const unitOf = (id: string) => metrics.find((m) => m.id === id)?.unit ?? "";
  const macroCells = (key: keyof typeof MACRO_IDS): DayCell[] => {
    const r = shown?.get(MACRO_IDS[key]);
    return r ? buildCells(r) : days.map((day) => ({ kind: "none", day }));
  };
  const haveMacros = Object.values(MACRO_IDS).every((id) => metrics.some((m) => m.id === id));
  const macros = shown && haveMacros
    ? macroRows(days, { energy: macroCells("energy"), protein: macroCells("protein"), carbohydrates: macroCells("carbohydrates"), fat: macroCells("fat") })
    : null;
  const computedAt = main?.completeness.lastComputedAt;

  return (
    <section className="nutrition" aria-labelledby="nutrition-h">
      <h2 id="nutrition-h">Nutrition</h2>

      <div className="filters trend-filters">
        <div role="group" aria-label="Days shown" className="field-row">
          {PRESETS.map((d) => (
            <button key={d} type="button" aria-pressed={count === d} className={count === d ? "pressed" : undefined} onClick={() => setCount(d)}>
              {d} days
            </button>
          ))}
          <button type="button" onClick={refresh}>Refresh</button>
        </div>
        <div role="group" aria-label="Nutrient" className="field-row">
          {metrics.map((m) => (
            <button key={m.id} type="button" aria-pressed={selected.id === m.id} className={selected.id === m.id ? "pressed" : undefined} onClick={() => setChosen(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Breakdown" className="field-row">
          <button type="button" aria-pressed={split} className={split ? "pressed" : undefined} onClick={() => setSplit((s) => !s)}>
            Split by meal
          </button>
        </div>
        <p className="muted small">
          Showing {range.from} to {range.to}. Days are <strong>days as recorded</strong>: the date written in each entry&apos;s own
          timestamp, not the UTC day that Trends and Sleep use. The last day shown is today&apos;s date in UTC, so an entry recorded
          at a later date east of UTC appears once UTC reaches it. A day with no entries is an empty slot, never a total of 0.
        </p>
      </div>

      {pending > 0 && (
        <p role="status" className="state">
          {pending} window{pending === 1 ? "" : "s"} changed and not yet recomputed: the most recent totals may be out of date.
        </p>
      )}
      {load.kind === "error" && (
        <div role="alert" className="state state-error">
          <h3>{load.error.title}</h3>
          <p>{load.error.detail}</p>
          {load.error.retry && <button type="button" onClick={refresh}>Try again</button>}
        </div>
      )}
      {shown === null && load.kind === "loading" && <p role="status" className="state">Loading nutrition…</p>}

      {cells && (
        <section className={`trend-card${busy ? " trend-busy" : ""}`} aria-labelledby="nutrient-h" aria-busy={busy}>
          <h3 id="nutrient-h">
            <span className={`trend-key slot-${slot}`} aria-hidden="true" />
            {selected.label} <span className="unit">({selected.unit})</span>
          </h3>
          <p className="trend-summary">{summaryText(selected.label, selected.unit, cells)}</p>
          {notice && <p className="trend-flags"><span aria-hidden="true">⚠ </span><strong>Data quality:</strong> {notice}</p>}
          {computedAt && <p className="muted small">Totals last changed {formatInstantUtc(computedAt)}.</p>}
          <NutritionChart
            cells={cells} label={selected.label} unit={selected.unit} slot={slot} split={split} meals={meals}
            mealLabel={mealLabel} mealClass={mealClass} busy={busy}
          />
          <details className="trend-table">
            <summary>Table view</summary>
            <div className="table-scroll"><table className="values">
              <caption className="sr-only">{`${selected.label} by day as recorded, newest first`}</caption>
              <thead>
                <tr>
                  <th scope="col">Day (as recorded)</th><th scope="col">{`Total (${selected.unit})`}</th><th scope="col">Entries</th>
                  {meals.map((m) => <th key={m} scope="col">{mealLabel(m)}</th>)}
                  <th scope="col">Flagged</th><th scope="col">Late</th>
                </tr>
              </thead>
              <tbody>
                {[...cells].reverse().map((c) => c.kind === "none" ? (
                  <tr key={c.day} className="no-data"><th scope="row">{c.day}</th><td colSpan={meals.length + 4}>No entries</td></tr>
                ) : (
                  <tr key={c.day}>
                    <th scope="row">{c.day}</th>
                    <td className="num">{formatValue(c.total)}</td>
                    <td className="num">{c.entries}</td>
                    {meals.map((m) => {
                      const part = mealOf(c, m);
                      return <td key={m} className="num">{part ? formatValue(part.total) : "–"}</td>;
                    })}
                    <td className="num">{c.artifactSuspected}</td>
                    <td className="num">{c.lateArrival}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <p className="muted small">
              A dash in a meal column means no entries for that meal that day. A total of 0 means entries that add up to 0; a row
              reading &quot;No entries&quot; means nothing was recorded.
            </p>
          </details>
        </section>
      )}

      {macros && (
        <section className={`trend-card${busy ? " trend-busy" : ""}`} aria-labelledby="macros-h" aria-busy={busy}>
          <h3 id="macros-h">Energy and macronutrients</h3>
          <p className="trend-summary">
            {(() => {
              const have = macros.filter((r) => r.energy !== null).length;
              return `${have} of ${macros.length} days have energy entries. A dash means no entries for that nutrient on that day (not 0).`;
            })()}
          </p>
          <div className="table-scroll"><table className="values">
            <caption className="sr-only">Daily energy and macronutrient totals, and estimated shares of energy, by day as recorded, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Day (as recorded)</th>
                <th scope="col">{`Energy (${unitOf(MACRO_IDS.energy)})`}</th>
                <th scope="col">{`Protein (${unitOf(MACRO_IDS.protein)})`}</th>
                <th scope="col">{`Carbohydrates (${unitOf(MACRO_IDS.carbohydrates)})`}</th>
                <th scope="col">{`Fat (${unitOf(MACRO_IDS.fat)})`}</th>
                <th scope="col">Protein share (estimate)</th>
                <th scope="col">Carbohydrate share (estimate)</th>
                <th scope="col">Fat share (estimate)</th>
              </tr>
            </thead>
            <tbody>
              {[...macros].reverse().map((r) => {
                const v = (x: number | null) => x === null ? <><span aria-hidden="true">–</span><span className="sr-only">no entries</span></> : formatValue(x);
                const s = (x: number | undefined) => x === undefined ? <><span aria-hidden="true">–</span><span className="sr-only">not estimated</span></> : `${x}%`;
                return (
                  <tr key={r.day}>
                    <th scope="row">{r.day}</th>
                    <td className="num">{v(r.energy)}</td><td className="num">{v(r.protein)}</td>
                    <td className="num">{v(r.carbohydrates)}</td><td className="num">{v(r.fat)}</td>
                    <td className="num">{s(r.share?.protein)}</td><td className="num">{s(r.share?.carbohydrates)}</td><td className="num">{s(r.share?.fat)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          <p className="muted small">
            <strong>The shares are estimates, not measurements.</strong> Each is the grams times {KCAL_PER_GRAM.protein} kcal
            (protein, carbohydrates) or {KCAL_PER_GRAM.fat} kcal (fat) per gram, divided by the day&apos;s reported energy. They
            need not add up to 100%: fibre, alcohol and rounding are not counted. A dash means a nutrient has no entries that day, or the
            day has no energy above 0, so no estimate is made.
          </p>
        </section>
      )}
    </section>
  );
}
