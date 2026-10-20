// Seeds KNOWN synthetic dietary intake days into the POC HAPI, for verifying the nutrition view (M23). Synthetic data
// only, written as the synthetic capture user by conditional create on fixed identifiers: running it again changes
// nothing.
//
//   make web-seed-nutrition-days
//
// 24 recorded days from 2026-09-21: meals with all of energy, protein, carbohydrates and fat, some with fibre, sodium
// and water, and these on purpose: three days with no entries at all (gaps), a day of entries that sum to zero, an
// evening entry that is the NEXT day in UTC (recorded 23:40 UTC-7), an entry with no meal, a dessert that is created
// and then retracted the way the app retracts a deletion (it must not count), and an implausible entry that carries the
// capture app's artifact-suspected tag (it counts, and is counted as suspect). The expected daily ENERGY totals are
// computed here in integer micro-units (`expectedEnergy`), a second implementation next to the analytics worker's.
import { contract, captureToken, findPatientId, fhir, metric, postConditional, syntheticSystem, withOffset } from "./common.mjs";

export const FIRST_DAY = "2026-09-21";
export const DAYS = 24;
const GAP_DAYS = [5, 6, 13];
const ZERO_DAY = 9;
const EVENING_DAY = 11;
const NO_MEAL_DAY = 15;
const RETRACTED_DAY = 17;
const FLAGGED_DAY = 19;

const dayOf = (i) => new Date(Date.UTC(2026, 8, 21) + i * 86_400_000).toISOString().slice(0, 10);
/** The instant of a local clock time in UTC-7 (PDT, in force for every seeded day). */
const pdt = (day, hhmm) => Date.parse(`${day}T${hhmm}:00-07:00`);
const MEALS = [
  { code: "breakfast", at: "08:10", base: 300, spread: 90, step: 53 },
  { code: "lunch", at: "12:30", base: 550, spread: 160, step: 71 },
  { code: "dinner", at: "19:00", base: 650, spread: 220, step: 97 },
  { code: "snack", at: "15:45", base: 120, spread: 80, step: 29 },
];
const round1 = (x) => Math.round(x * 10) / 10;

/** One entry: {key, nutrient, meal|null, ms, value, flags?, retract?}. Values carry at most one decimal. */
function entriesOfDay(i) {
  const day = dayOf(i);
  if (GAP_DAYS.includes(i)) return [];
  const out = [];
  const add = (key, nutrient, meal, ms, value, extra = {}) => out.push({ key, nutrient, meal, ms, value, ...extra });
  if (i === ZERO_DAY) {
    add("z1", "dietaryEnergy", "snack", pdt(day, "10:00"), 0);
    add("z2", "dietaryEnergy", "snack", pdt(day, "16:00"), 0);
    return out;
  }
  for (const m of MEALS) {
    if (m.code === "snack" && i % 3 === 0) continue; // not every day has a snack
    const kcal = m.base + ((i * m.step) % m.spread);
    const label = i === NO_MEAL_DAY && m.code === "snack" ? null : m.code;
    const ms = pdt(day, m.at);
    add(`${m.code}-e`, "dietaryEnergy", label, ms, kcal);
    add(`${m.code}-p`, "dietaryProtein", label, ms, round1(kcal * 0.17 / 4));
    add(`${m.code}-c`, "dietaryCarbohydrates", label, ms, round1(kcal * 0.5 / 4));
    add(`${m.code}-f`, "dietaryFat", label, ms, round1(kcal * 0.33 / 9));
    if (m.code === "lunch" || m.code === "dinner") add(`${m.code}-fib`, "dietaryFiber", label, ms, round1(kcal / 90));
    if (m.code === "dinner") add(`${m.code}-na`, "dietarySodium", label, ms, 600 + (i * 37) % 400);
    if (m.code === "breakfast") add(`${m.code}-w`, "dietaryWater", label, ms, 250 + (i * 11) % 100);
  }
  if (i === EVENING_DAY) add("late-e", "dietaryEnergy", "snack", pdt(day, "23:40"), 220);
  if (i === NO_MEAL_DAY) add("nomeal-e", "dietaryEnergy", null, pdt(day, "21:00"), 180);
  if (i === RETRACTED_DAY) add("dessert-e", "dietaryEnergy", "dinner", pdt(day, "20:30"), 999, { retract: true });
  if (i === FLAGGED_DAY) add("absurd-e", "dietaryEnergy", "lunch", pdt(day, "13:00"), 7200, { flags: ["artifactSuspected"] });
  return out;
}

export const FIXTURE_DAYS = Array.from({ length: DAYS }, (_, i) => ({ day: dayOf(i), i, entries: entriesOfDay(i) }));

/** The expected total of each nutrient per day, from the entries that count (not retracted), in integer micro-units. */
export function expectedTotals() {
  const out = new Map(); // `${nutrient}|${day}` -> { micro, entries, byMeal: Map, flagged }
  for (const d of FIXTURE_DAYS) {
    for (const e of d.entries) {
      if (e.retract) continue;
      const key = `${e.nutrient}|${d.day}`;
      const cell = out.get(key) ?? { micro: 0n, entries: 0, byMeal: new Map(), flagged: 0 };
      const micro = BigInt(Math.round(e.value * 1_000_000));
      cell.micro += micro;
      cell.entries += 1;
      const meal = e.meal ?? "unlabelled";
      cell.byMeal.set(meal, (cell.byMeal.get(meal) ?? 0n) + micro);
      if (e.flags?.includes("artifactSuspected")) cell.flagged += 1;
      out.set(key, cell);
    }
  }
  return out;
}
export const microToNumber = (micro) => Number(micro) / 1_000_000;

export function buildObservations(patientId) {
  const items = [];
  for (const d of FIXTURE_DAYS) {
    for (const e of d.entries) {
      const m = metric(e.nutrient);
      const named = m.customCode ?? m.loinc;
      const system = m.customCode ? contract.systems[m.customCode.system] : contract.systems.loinc;
      const identifier = `nutrition-fixture-${d.day}-${e.key}`;
      items.push({
        identifier,
        retract: Boolean(e.retract),
        resource: {
          resourceType: "Observation",
          meta: {
            source: contract.systems.metaSource.synthetic,
            ...(e.flags ? { tag: e.flags.map((f) => ({ system: contract.systems.dataQualityFlag, code: contract.dataQualityFlags[f] })) } : {}),
          },
          identifier: [{ system: syntheticSystem, value: identifier }],
          status: "final",
          category: [
            { coding: [{ system: contract.systems.observationDomain, code: m.domain, display: contract.domains[m.domain].display }] },
            ...(e.meal ? [{ coding: [{ system: contract.systems.mealType, code: e.meal }], text: contract.mealTypes[e.meal].display }] : []),
          ],
          code: { coding: [{ system, code: named.code }] },
          subject: { reference: `Patient/${patientId}` },
          effectiveDateTime: withOffset(e.ms),
          valueQuantity: { value: e.value, unit: m.unit.ucum, system: contract.systems.ucum, code: m.unit.ucum },
        },
      });
    }
  }
  return items;
}

/** What the capture app's retraction sends: one conditional JSON Patch of the status, by the sample's identifier. */
async function retract(tok, identifier) {
  const q = encodeURIComponent(`${syntheticSystem}|${identifier}`);
  const r = await fetch(`${fhir}/Observation?identifier=${q}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json-patch+json", Accept: "application/fhir+json" },
    body: JSON.stringify([{ op: "replace", path: "/status", value: "entered-in-error" }]),
  });
  return r.status;
}

async function main() {
  const tok = await captureToken();
  const patientId = await findPatientId(tok);
  const items = buildObservations(patientId);
  const r = await postConditional(tok, items, { size: 100 });
  let retracted = 0;
  for (const it of items.filter((x) => x.retract)) {
    const status = await retract(tok, it.identifier);
    if (status !== 200) { console.error(`retracting ${it.identifier}: HTTP ${status}`); process.exit(1); }
    retracted++;
  }
  console.log(`nutrition fixtures: ${items.length} Observations over ${DAYS} days from ${FIRST_DAY}; ${r.created} created, ${r.existing} already there, ${r.failed} failed; ${retracted} retracted (as the app does)`);
  console.log(`  gaps: ${GAP_DAYS.map(dayOf).join(", ")}; a day summing to zero: ${dayOf(ZERO_DAY)}; an evening entry: ${dayOf(EVENING_DAY)}`);
  console.log(`  no meal: ${dayOf(NO_MEAL_DAY)}; a retracted dessert: ${dayOf(RETRACTED_DAY)}; a flagged absurd entry: ${dayOf(FLAGGED_DAY)}`);
  if (r.failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
