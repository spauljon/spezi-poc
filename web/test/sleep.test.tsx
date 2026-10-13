import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { AppUser, AuthClient } from "../src/auth/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { SleepPage } from "../src/sleep/SleepPage.tsx";
import { NOW, config, contract, fakeHapi } from "./support.ts";
import { KNOWN_OBSERVATIONS, sessionRow } from "./sleep-fixtures.ts";

const user: AppUser = { username: "clinician-user", roles: ["clinician-reader"], expiresAt: Date.now() + 600_000 };
const client = (): AuthClient => ({
  getUser: async () => user, signIn: async () => undefined, completeSignIn: async () => user,
  accessToken: async () => "tok", signOut: async () => undefined, onSignedOut: () => () => undefined,
});

function mount(
  props: Partial<React.ComponentProps<typeof SleepPage>> = {},
  opts: { observations?: Observation[]; sleep?: ReturnType<typeof sessionRow>[]; status?: number; analyticsStatus?: number; pending?: number } = {},
) {
  const fake = fakeHapi(opts.observations ?? KNOWN_OBSERVATIONS, {
    analytics: {}, analyticsStatus: opts.analyticsStatus ?? 200, status: opts.status ?? 200,
    analyticsOver: { sleep: opts.sleep ?? [sessionRow()], pendingWindows: opts.pending ?? 0 },
  });
  vi.stubGlobal("fetch", fake);
  render(
    <AuthProvider client={client()} location={{ pathname: "/", href: "https://web.test:3000/", origin: "https://web.test:3000" }} history={{ replaceState: vi.fn() }}>
      <SleepPage config={config} contract={contract} patientId="1" night={null} start={null} now={() => NOW} {...props} />
    </AuthProvider>,
  );
  return fake;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the nights", () => {
  it("shows the nights, each with sleep as a link; a night without sleep is an empty slot, said in words", async () => {
    mount();
    expect(await screen.findByText(/1 of 30 nights have a recorded sleep; 29 have none/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /^2026-09-28: asleep 6 h 37 min; deep 1 h 15 min, light 2 h 55 min, REM 1 h 57 min; 1 awakenings/ });
    expect(link.getAttribute("href")).toBe("#/sleep/2026-09-28");
    expect(document.querySelectorAll(".sleep-summary a")).toHaveLength(1);
  });

  it("has a table twin with shares, awakenings and 'No sleep recorded' rows", async () => {
    mount({}, { sleep: [sessionRow(), { ...sessionRow(), isMain: false, start: "2026-09-28T21:00:00.000Z", end: "2026-09-28T21:40:00.000Z", onset: "2026-09-28T21:00:00.000Z", finalWaking: "2026-09-28T21:40:00.000Z", asleepMin: 40, coreMin: 0, deepMin: 0, remMin: 0, unspecifiedMin: 40, awakeMin: 0, latencyMin: 0, wakeAfterEndMin: 0, unscoredMin: 0, overlapMin: 0, awakenings: 0, intervalCount: 1 }] });
    await screen.findByText(/nights have a recorded sleep/);
    const table = within(document.querySelector("details.trend-table")!).getByRole("table", { hidden: true });
    const row = within(table).getByRole("row", { name: /2026-09-28/, hidden: true });
    expect(row.textContent).toContain("6 h 37 min");
    expect(row.textContent).toContain("19%"); // deep 75 of 397
    expect(row.textContent).toContain("40 min"); // the nap, listed with the night
    expect(within(table).getByRole("row", { name: /2026-09-27/, hidden: true }).textContent).toContain("No sleep recorded");
  });

  it("asks the API for the chosen number of nights ending today (UTC)", async () => {
    const fake = mount();
    await screen.findByText(/nights have a recorded sleep/);
    expect(fake.urls.find((u) => u.includes("/sleep?"))).toContain("from=2026-09-13&to=2026-10-12");
    fireEvent.click(screen.getByRole("button", { name: "90 nights" }));
    await waitFor(() => expect(fake.urls.some((u) => u.includes("from=2026-07-15&to=2026-10-12"))).toBe(true));
    expect(screen.getByRole("button", { name: "90 nights" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("says when the worker has windows it has not recomputed (and nothing when it has none)", async () => {
    mount({}, { pending: 3 });
    expect(await screen.findByText(/3 windows changed and not yet recomputed/)).toBeTruthy();
    cleanup();
    mount();
    await screen.findByText(/nights have a recorded sleep/);
    expect(screen.queryByText(/not yet recomputed/)).toBeNull();
  });

  it("explains a service failure in words with a retry where one can help", async () => {
    mount({}, { analyticsStatus: 503 });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/analytic store is not available/);
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("one night", () => {
  it("draws the resolved timeline: 15 stretches, the overlap and the unscored gap said in words", async () => {
    mount({ night: "2026-09-28" });
    const group = await screen.findByRole("group", { name: /^Hypnogram, night ending 2026-09-28/ });
    expect(group).toBeTruthy();
    const card = document.getElementById("night-h")!.closest("section")!;
    expect(card.textContent).toMatch(/Night: asleep 6 h 37 min from 06:00 \(UTC\+00:00\) to 13:00 \(UTC\+00:00\)/);
    expect(card.textContent).toContain("10 min inside the night has no recorded stage");
    expect(card.textContent).toContain("10 min is covered by more than one interval");
    const table = within(card).getAllByRole("table", { hidden: true }).at(-1)!;
    expect(within(table).getAllByRole("row", { hidden: true })).toHaveLength(1 + 15);
    expect(within(table).getByText("No interval recorded")).toBeTruthy();
    expect(within(table).getAllByText(/Overlap: the interval that starts later is shown/)).toHaveLength(1);
    expect(card.querySelectorAll(".overlap-mark")).toHaveLength(1);
    // no disagreement with the analytic summary (control for the next test)
    expect(card.textContent).not.toMatch(/disagree/);
  });

  it("flags a disagreement between the intervals and the analytic summary", async () => {
    mount({ night: "2026-09-28" }, { sleep: [sessionRow({ awakenings: 2 })] });
    expect(await screen.findByText(/disagree on awakenings: the intervals give 1, the summary says 2/)).toBeTruthy();
  });

  it("reads a stretch at a time with the keyboard", async () => {
    mount({ night: "2026-09-28" });
    const group = await screen.findByRole("group", { name: /^Hypnogram/ });
    fireEvent.keyDown(group, { key: "Home" });
    expect(screen.getByText("05:30 to 06:00: Awake, 30 min")).toBeTruthy();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(screen.getByText("06:00 to 06:45: Light, 45 min")).toBeTruthy();
    fireEvent.keyDown(group, { key: "End" });
    expect(screen.getByText("13:00 to 13:30: Awake, 30 min")).toBeTruthy();
    // the unscored gap is read as a gap, not as a stage
    fireEvent.keyDown(group, { key: "Home" });
    for (let i = 0; i < 9; i++) fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(screen.getByText("09:40 to 09:50: no interval recorded, 10 min")).toBeTruthy();
  });

  it("offers the sessions of a night and opens the one asked for", async () => {
    const napObs: Observation[] = [
      { ...KNOWN_OBSERVATIONS[1]!, id: "n1", code: KNOWN_OBSERVATIONS[7]!.code!, effectivePeriod: { start: "2026-09-28T21:00:00+00:00", end: "2026-09-28T21:40:00+00:00" } },
    ];
    const nap = { ...sessionRow(), isMain: false, start: "2026-09-28T21:00:00.000Z", end: "2026-09-28T21:40:00.000Z", onset: "2026-09-28T21:00:00.000Z", finalWaking: "2026-09-28T21:40:00.000Z", asleepMin: 40, coreMin: 0, deepMin: 0, remMin: 0, unspecifiedMin: 40, awakeMin: 0, latencyMin: 0, wakeAfterEndMin: 0, unscoredMin: 0, overlapMin: 0, awakenings: 0, intervalCount: 1 };
    const start = Date.parse(nap.start) / 1000;
    mount({ night: "2026-09-28", start }, { observations: [...KNOWN_OBSERVATIONS, ...napObs], sleep: [sessionRow(), nap] });
    const card = (await waitFor(() => document.getElementById("night-h")!.closest("section")!));
    await waitFor(() => expect(card.textContent).toMatch(/Nap: asleep 40 min/));
    const choices = within(card).getByRole("group", { name: /Sleep sessions on this date/ });
    // a session's link names it by its start (epoch seconds of 05:30Z), so it is reproducible and bookmarkable
    expect(within(choices).getByRole("link", { name: /Main sleep \(6 h 37 min\)/ }).getAttribute("href")).toBe("#/sleep/2026-09-28?s=1790573400");
    expect(choices.querySelector("strong")!.textContent).toBe("Nap (40 min)");
  });

  it("says so when the summary lists a night whose intervals cannot be read (nothing is drawn)", async () => {
    mount({ night: "2026-09-28" }, { observations: [] });
    expect(await screen.findByText(/no stage intervals could be read for it/)).toBeTruthy();
    expect(document.querySelector(".hypnogram")).toBeNull();
  });

  it("says there is no sleep for a date that has none", async () => {
    mount({ night: "2026-09-20" });
    expect(await screen.findByText(/No sleep is recorded for the night of 2026-09-20/)).toBeTruthy();
  });
});

describe("a night across a clock change", () => {
  const P = (stage: string, start: string, end: string, id: string): Observation => ({
    ...KNOWN_OBSERVATIONS[1]!, id,
    code: { coding: [{ system: contract.loincSystem, code: contract.sleepStages.find((s) => s.id === stage)!.loincCode }] },
    effectivePeriod: { start, end },
  });
  const dst: Observation[] = [
    P("asleepCore", "2026-03-07T23:00:00-08:00", "2026-03-07T23:45:00-08:00", "d1"),
    P("asleepDeep", "2026-03-07T23:45:00-08:00", "2026-03-08T00:30:00-08:00", "d2"),
    P("asleepREM", "2026-03-08T00:30:00-08:00", "2026-03-08T01:30:00-08:00", "d3"),
    P("asleepCore", "2026-03-08T01:30:00-08:00", "2026-03-08T03:30:00-07:00", "d4"),
    P("asleepDeep", "2026-03-08T03:30:00-07:00", "2026-03-08T04:30:00-07:00", "d5"),
    P("awake", "2026-03-08T04:30:00-07:00", "2026-03-08T05:00:00-07:00", "d6"),
  ];
  const session = sessionRow({
    night: "2026-03-08", start: "2026-03-08T07:00:00.000Z", end: "2026-03-08T12:00:00.000Z", onset: "2026-03-08T07:00:00.000Z",
    finalWaking: "2026-03-08T11:30:00.000Z", asleepMin: 270, coreMin: 135, deepMin: 105, remMin: 60, unspecifiedMin: 0,
    awakeMin: 0, latencyMin: 0, wakeAfterEndMin: 30, unscoredMin: 0, overlapMin: 0, awakenings: 0, intervalCount: 6,
  });

  it("states that the clock changed, in real and clock time, and shows no invented time inside the change", async () => {
    mount({ night: "2026-03-08" }, { observations: dst, sleep: [session] });
    const card = await waitFor(() => document.getElementById("night-h")!.closest("section")!);
    await waitFor(() => expect(card.textContent).toMatch(/offset changed during this night \(UTC-08:00 then UTC-07:00\)/));
    expect(card.textContent).toMatch(/Clock times as recorded by the device \(UTC-08:00, then UTC-07:00\)/);
    expect(card.textContent).toMatch(/real time, .* on the clock/);
    // the readout of the interval that spans the change names its own recorded boundaries
    const group = within(card).getByRole("group", { name: /^Hypnogram/ });
    fireEvent.keyDown(group, { key: "Home" });
    for (let i = 0; i < 3; i++) fireEvent.keyDown(group, { key: "ArrowRight" });
    // the clock reads two hours across the change; one real hour elapsed, and the minutes are real minutes
    expect(screen.getByText("01:30 to 03:30: Light, 1 h 00 min")).toBeTruthy();
  });
});
