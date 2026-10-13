// Seeds a few KNOWN synthetic sleep nights into the POC HAPI, for verifying the sleep view (M16). Synthetic data only,
// written as the synthetic capture user by conditional create on fixed identifiers: running it again changes nothing.
//
//   make web-seed-sleep-nights
//
// Each night is described by its stage intervals (UTC instants) and by what a per-minute reading of them must give.
// That reading (`expected`) is deliberately a THIRD, naive implementation (paint every minute, later start wins), so
// the analytics worker's summary, the web app's interval sweep and this one can only agree by being right.
import { contract, captureToken, findPatientId, metric, postConditional, syntheticSystem, withOffset } from "./common.mjs";

const STAGE_CODE = Object.fromEntries(Object.entries(metric("sleepStage").stages).map(([id, s]) => [id, s.code]));
const ASLEEP = ["asleepCore", "asleepDeep", "asleepREM", "asleepUnspecified"];

const utc = (iso) => Date.parse(iso);
/** Intervals as [stage, "HH:MM" start, "HH:MM" end] on the given UTC date (end may roll past midnight via +1d). */
const at = (day, hhmm, plusDays = 0) => utc(`${day}T${hhmm}:00Z`) + plusDays * 86_400_000;

/** A night is {id, label, intervals:[{stage,startMs,endMs}]}; times are minute-aligned UTC instants. */
export const NIGHTS = [
  {
    // PDT (-07:00). Local 22:30 on the 27th to 06:30 on the 28th = 05:30Z to 13:30Z.
    id: "known", night: "2026-09-28", label: "a known night: overlap, unscored gap, a 3-minute awake, an awakening",
    intervals: [
      ["awake", "05:30", "06:00"], ["asleepCore", "06:00", "06:45"], ["asleepDeep", "06:45", "07:30"],
      ["asleepCore", "07:30", "08:00"], ["awake", "08:00", "08:03"], ["asleepREM", "08:03", "09:00"],
      ["asleepCore", "09:00", "09:20"], ["asleepUnspecified", "09:10", "09:40"], // overlaps the core by 10 min
      // 09:40-09:50: no interval at all (unscored)
      ["asleepDeep", "09:50", "10:20"], ["awake", "10:20", "10:30"], ["asleepCore", "10:30", "12:00"],
      ["asleepREM", "12:00", "13:00"], ["awake", "13:00", "13:30"],
    ].map(([stage, a, b]) => ({ stage, startMs: at("2026-09-28", a), endMs: at("2026-09-28", b) })),
  },
  {
    // A main night and a nap on the same UTC date (the nap is 14:00-14:40 PDT = 21:00-21:40Z)
    id: "nap", night: "2026-09-30", label: "a night and a nap on the same date",
    intervals: [
      ["asleepCore", "05:45", "06:30"], ["asleepDeep", "06:30", "07:15"], ["asleepCore", "07:15", "08:00"],
      ["asleepREM", "08:00", "08:45"], ["asleepCore", "08:45", "10:00"], ["asleepDeep", "10:00", "10:30"],
      ["asleepREM", "10:30", "11:30"], ["asleepCore", "11:30", "13:15"],
      ["asleepUnspecified", "21:00", "21:40"],
    ].map(([stage, a, b]) => ({ stage, startMs: at("2026-09-30", a), endMs: at("2026-09-30", b) })),
  },
  {
    // The spring-forward night in Los Angeles: 02:00 PST became 03:00 PDT at 10:00Z. One interval spans the change.
    id: "dst", night: "2026-03-08", label: "a night across the DST change (PST to PDT)",
    intervals: [
      ["asleepCore", "07:00", "07:45"], ["asleepDeep", "07:45", "08:30"], ["asleepREM", "08:30", "09:30"],
      ["asleepCore", "09:30", "10:30"], // 01:30 PST to 03:30 PDT
      ["asleepDeep", "10:30", "11:30"], ["asleepCore", "11:30", "12:30"], ["asleepREM", "12:30", "13:30"],
      ["awake", "13:30", "14:00"],
    ].map(([stage, a, b]) => ({ stage, startMs: at("2026-03-08", a), endMs: at("2026-03-08", b) })),
  },
];

/**
 * What the intervals must come to, read minute by minute: every minute gets the stage of the interval that started
 * LAST among those covering it. No sweep, no sorting tricks: the slow, obvious version.
 */
function expectedOne(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const first = Math.min(...sorted.map((i) => i.startMs));
  const last = Math.max(...sorted.map((i) => i.endMs));
  const minutes = [];
  for (let t = first; t < last; t += 60_000) {
    const covering = sorted.filter((i) => i.startMs <= t && t < i.endMs);
    minutes.push({ t, stage: covering.length ? covering[covering.length - 1].stage : null, n: covering.length });
  }
  const asleepIdx = minutes.flatMap((m, i) => (ASLEEP.includes(m.stage) ? [i] : []));
  const on = asleepIdx[0];
  const off = asleepIdx[asleepIdx.length - 1];
  const within = minutes.slice(on, off + 1);
  const count = (s) => within.filter((m) => m.stage === s).length;
  // awakenings: runs of "awake" minutes of 5 or more, strictly between onset and final waking
  let awakenings = 0;
  for (let i = 0, run = 0; i < within.length; i++) {
    if (within[i].stage === "awake") run++;
    if (within[i].stage !== "awake" || i === within.length - 1) {
      if (run >= 5) awakenings++;
      run = 0;
    }
  }
  return {
    sessionStartMs: first, sessionEndMs: last, onsetMs: minutes[on].t, finalWakingMs: minutes[off].t + 60_000,
    latencyMin: on, wakeAfterEndMin: minutes.length - 1 - off,
    asleepMin: ASLEEP.reduce((s, st) => s + count(st), 0),
    coreMin: count("asleepCore"), deepMin: count("asleepDeep"), remMin: count("asleepREM"), unspecifiedMin: count("asleepUnspecified"),
    awakeMin: count("awake"), unscoredMin: within.filter((m) => m.stage === null).length,
    overlapMin: within.filter((m) => m.n > 1).length, awakenings, intervalCount: intervals.length,
    // UTC date of the final waking from sleep: the night's date (A6)
    night: new Date(minutes[off].t + 60_000).toISOString().slice(0, 10),
  };
}

/** A new session starts when an interval begins more than two hours after everything before it has ended. */
export function expectedSessions(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const groups = [];
  let runEnd = -Infinity;
  for (const iv of sorted) {
    if (groups.length === 0 || iv.startMs - runEnd > 2 * 3_600_000) groups.push([]);
    groups[groups.length - 1].push(iv);
    runEnd = groups.length === 1 && groups[0].length === 1 ? iv.endMs : Math.max(runEnd, iv.endMs);
  }
  const sessions = groups.map(expectedOne);
  // per date, the session with the most time asleep is the main sleep; the others are naps
  for (const x of sessions) {
    const rivals = sessions.filter((y) => y.night === x.night);
    x.isMain = rivals.every((y) => y === x || y.asleepMin < x.asleepMin);
  }
  return sessions;
}

export function buildObservations(patientId, night) {
  const m = metric("sleepStage");
  return night.intervals.map((iv, i) => {
    const minutes = (iv.endMs - iv.startMs) / 60_000;
    const identifier = `sleep-fixture-${night.id}-${i}`;
    return {
      identifier,
      resource: {
        resourceType: "Observation",
        meta: { source: contract.systems.metaSource.synthetic },
        identifier: [{ system: syntheticSystem, value: identifier }],
        status: "final",
        category: [{ coding: [{ system: contract.systems.observationCategory, code: m.category }] }],
        code: { coding: [{ system: contract.systems.loinc, code: STAGE_CODE[iv.stage] }] },
        subject: { reference: `Patient/${patientId}` },
        effectivePeriod: { start: withOffset(iv.startMs), end: withOffset(iv.endMs) },
        valueQuantity: { value: minutes, unit: m.unit.ucum, system: contract.systems.ucum, code: m.unit.ucum },
      },
    };
  });
}

async function main() {
  const tok = await captureToken();
  const patientId = await findPatientId(tok);
  const items = NIGHTS.flatMap((n) => buildObservations(patientId, n));
  const r = await postConditional(tok, items, { size: 50 });
  console.log(`sleep fixtures: ${items.length} Observations over ${NIGHTS.length} nights; ${r.created} created, ${r.existing} already there, ${r.failed} failed`);
  for (const n of NIGHTS) console.log(`  ${n.night}  ${n.label}`);
  if (r.failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
