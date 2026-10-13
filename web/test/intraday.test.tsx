import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { AppUser, AuthClient } from "../src/auth/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { IntradayPage } from "../src/intraday/IntradayPage.tsx";
import { FakeUPlot } from "./uplot-fake.ts";
import { config, contract, fakeHapi, obs } from "./support.ts";

const user: AppUser = { username: "clinician-user", roles: ["clinician-reader"], expiresAt: Date.now() + 600_000 };
const client = (): AuthClient => ({
  getUser: async () => user, signIn: async () => undefined, completeSignIn: async () => user,
  accessToken: async () => "tok", signOut: async () => undefined, onSignedOut: () => () => undefined,
});
const DAY = "2026-09-25";
const t0 = Date.parse(`${DAY}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString();
const flag = contract.dataQualityFlag;
const TODAY = new Date("2026-10-12T12:00:00Z");

/** One heart-rate sample a minute for 24 h, except a pause from 02:10 to 03:30 (80 min); some samples flagged. */
function heartRate(): Observation[] {
  const out: Observation[] = [];
  for (let m = 0; m < 1440; m++) {
    if (m > 130 && m < 210) continue;
    const t = iso(t0 + m * 60_000);
    const o = obs("heartRate", 60 + (m % 12), t, t);
    o.id = `hr-${String(m).padStart(4, "0")}`;
    if (m === 600) { o.valueQuantity = { ...o.valueQuantity!, value: 250 }; o.meta = { ...o.meta, tag: [{ system: flag.system, code: flag.artifactSuspected }] }; }
    if (m === 900) { o.valueQuantity = { ...o.valueQuantity!, value: 240 }; } // implausible and NOT flagged
    out.push(o);
  }
  return out;
}
function hrv(): Observation[] {
  return Array.from({ length: 48 }, (_, i) => {
    const t = iso(t0 + i * 30 * 60_000);
    const o = obs("hrvSdnn", 40 + (i % 7), t, t);
    o.id = `hrv-${i}`;
    return o;
  });
}

function mount(
  observations: Observation[] = [...heartRate(), ...hrv()],
  props: Partial<React.ComponentProps<typeof IntradayPage>> = {},
  opts: Parameters<typeof fakeHapi>[1] = {},
) {
  const fake = fakeHapi(observations, opts);
  vi.stubGlobal("fetch", fake);
  render(
    <AuthProvider client={client()} location={{ pathname: "/", href: "https://web.test:3000/", origin: "https://web.test:3000" }} history={{ replaceState: vi.fn() }}>
      <IntradayPage config={config} contract={contract} patientId="42" day={DAY} metric={null} range={null} now={() => TODAY} {...props} />
    </AuthProvider>,
  );
  return fake;
}
const cards = () => Array.from(document.querySelectorAll<HTMLElement>("section.trend-card"));
const cardFor = (display: string) => {
  const c = cards().find((x) => (x.querySelector("h3")?.textContent ?? "").startsWith(`${display} (`));
  if (!c) throw new Error(`no card for ${display}`);
  return c;
};

beforeEach(() => FakeUPlot.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("intraday page", () => {
  it("shows heart rate and HRV for the day, each with its summary, and says what it is", async () => {
    mount();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.getByRole("heading", { name: /Intraday: 2026-09-25 \(UTC\)/ })).toBeTruthy();
    const heart = cardFor("Heart rate");
    expect(heart.textContent).toContain("1,361 samples");
    expect(heart.textContent).toMatch(/1 gap of 10 min or more: 02:10 to 03:30 UTC, 80 min/);
    expect(cardFor("Heart rate variability SDNN [Time]").textContent).toContain("48 samples");
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(2));
  });

  it("hands each chart a break at the gap and shares one cursor between them", async () => {
    mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(2));
    const [a, b] = FakeUPlot.instances;
    const y = a!.data[1] as Array<number | null>;
    // one break inside the pause, plus the value-less anchor at the end of the day (the last sample is 23:59)
    expect(y.filter((v) => v === null)).toHaveLength(2);
    expect(y[0]).not.toBeNull(); // the day starts with a sample at 00:00: no start anchor
    expect(y[y.length - 1]).toBeNull();
    expect(a!.opts.series[1]!.spanGaps).toBe(false);
    expect(a!.opts.cursor?.sync?.key).toBe(`intraday-${DAY}`);
    expect(b!.opts.cursor?.sync?.key).toBe(a!.opts.cursor?.sync?.key);
  });

  it("marks only the stored flag: the unflagged implausible value is shown, not marked, and the summary says so", async () => {
    mount();
    const heart = await waitFor(() => cardFor("Heart rate"));
    await waitFor(() => expect(heart.textContent).toMatch(/highest 250 \/min at 10:00 UTC \(flagged\)/));
    expect(heart.textContent).toContain("1 sample carries a stored data-quality flag");
    fireEvent.click(within(heart).getByText(/Flagged samples \(1\)/));
    expect(within(heart).getByText(/10:00 UTC: 250 \/min, artifact suspected/)).toBeTruthy();
    expect(heart.textContent).not.toMatch(/15:00 UTC: 240/); // the 240 is not in the flagged list
    // positive control: with no flags stored the page says so and offers no flagged list
    cleanup(); FakeUPlot.reset();
    mount(heartRate().map((o) => { const { tag: _t, ...meta } = o.meta ?? {}; return { ...o, meta }; }));
    const plain = await waitFor(() => cardFor("Heart rate"));
    await waitFor(() => expect(plain.textContent).toContain("No sample carries a stored data-quality flag"));
    expect(within(plain).queryByText(/Flagged samples/)).toBeNull();
  });

  it("zoom buttons set the shared window; a drag on one chart moves the other", async () => {
    mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(2));
    const [a, b] = FakeUPlot.instances;
    fireEvent.click(screen.getByRole("button", { name: "6 hours" }));
    const noon = (t0 + 12 * 3600_000) / 1000;
    await waitFor(() => expect(a!.scales["x"]).toEqual({ min: noon - 10_800, max: noon + 10_800 }));
    expect(b!.scales["x"]).toEqual(a!.scales["x"]);
    expect(screen.getByRole("button", { name: "Full day" }).getAttribute("aria-pressed")).toBe("false");

    // the user drags across the first chart (the library reports the new window to the app)
    act(() => a!.setScale("x", { min: noon - 600, max: noon + 600 }));
    await waitFor(() => expect(b!.scales["x"]).toEqual({ min: noon - 600, max: noon + 600 }));

    fireEvent.click(screen.getByRole("button", { name: "Full day" }));
    await waitFor(() => expect(a!.scales["x"]).toEqual({ min: t0 / 1000, max: t0 / 1000 + 86_400 }));
    expect(screen.getByRole("button", { name: "‹ Earlier" })).toHaveProperty("disabled", true);
  });

  it("the keyboard steps through samples, scrolling the window to keep the sample in view, and reads its flag", async () => {
    mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(2));
    const heart = cardFor("Heart rate");
    const plot = within(heart).getByRole("group", { name: /Heart rate chart for 2026-09-25/ });
    fireEvent.keyDown(plot, { key: "Home" });
    expect(within(heart).getByText(/^00:00:00 UTC: 60 \/min$/)).toBeTruthy();
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    expect(within(heart).getByText(/^00:01:00 UTC: 61 \/min$/)).toBeTruthy();
    // jump to the flagged sample (index of 10:00): the readout names its flag
    for (let i = 0; i < 5; i++) fireEvent.keyDown(plot, { key: "PageDown" });
    expect(within(heart).getAllByText(/UTC: \d+(\.\d)? \/min/).length).toBeGreaterThan(0);
    fireEvent.keyDown(plot, { key: "End" });
    expect(within(heart).getByText(/^23:59:00 UTC/)).toBeTruthy();
  });

  it("names a flag in the readout when hovering it", async () => {
    mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(2));
    const heart = cardFor("Heart rate");
    // plotted index = model index + 1 break inserted before the first sample after the gap (model index > 130)
    const plotIdx = 600 - 79 + 1; // 600 minutes, minus the 79 missing samples, plus the break point
    act(() => FakeUPlot.instances[0]!.hover(plotIdx));
    expect(within(heart).getByText(/^10:00:00 UTC: 250 \/min \(flagged: artifact suspected\)$/)).toBeTruthy();
  });

  it("loads each metric's day once, even though the sign-in state settles after the page mounts", async () => {
    const fake = mount();
    await waitFor(() => expect(cards()).toHaveLength(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); }); // let any (wrong) reload surface
    const firstPages = fake.urls.filter((u) => u.includes("_offset=0"));
    expect(firstPages).toHaveLength(2); // heart rate and HRV, once each: not a second download of a dense day
    expect(FakeUPlot.instances.filter((p) => !p.destroyed)).toHaveLength(2);
  });

  it("a day with no samples says so", async () => {
    mount([]);
    await waitFor(() => expect(screen.getAllByText(/no samples\./).length).toBe(2));
    expect(FakeUPlot.instances).toHaveLength(0);
  });
});

describe("navigation", () => {
  const range = { from: "2026-09-13", to: "2026-10-12" };

  it("goes to the previous and next day and back to the trends, keeping the range", async () => {
    mount(undefined, { range });
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(screen.getByRole("link", { name: /Previous day/ }).getAttribute("href")).toBe("#/day/2026-09-24?metric=heartRate&from=2026-09-13&to=2026-10-12");
    expect(screen.getByRole("link", { name: /Next day/ }).getAttribute("href")).toBe("#/day/2026-09-26?metric=heartRate&from=2026-09-13&to=2026-10-12");
    expect(screen.getByRole("link", { name: /Back to trends/ }).getAttribute("href")).toBe("#/trends?from=2026-09-13&to=2026-10-12");
  });

  it("has no next day after the latest day (UTC today)", async () => {
    mount([], { day: "2026-10-12" });
    await screen.findByText(/This is the latest day/);
    expect(screen.queryByRole("link", { name: /Next day/ })).toBeNull();
  });

  it("lists the metric the drill came from first", async () => {
    mount(undefined, { metric: "hrvSdnn" });
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards()[0]!.querySelector("h3")!.textContent).toContain("variability");
  });
});

describe("states", () => {
  it("shows progress while a dense day loads", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    mount(undefined, {}, { delay: async (u) => { if (u.includes("_offset=0")) await gate; } });
    expect(await screen.findAllByRole("status")).not.toHaveLength(0);
    expect(screen.getAllByText(/Loading/).length).toBeGreaterThan(0);
    await act(async () => { release?.(); await gate; });
    await waitFor(() => expect(cards()).toHaveLength(2));
  });

  it("explains a failure and offers a retry that loads", async () => {
    let down = true;
    mount(undefined, {}, { failNetwork: () => down });
    const alerts = await screen.findAllByRole("alert");
    expect(alerts[0]!.textContent).toMatch(/could not be reached/);
    down = false;
    fireEvent.click(within(alerts[0]!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
  });

  it("an Observation in another unit is left out and the summary says so", async () => {
    const rows = heartRate();
    rows[10]!.valueQuantity = { value: 70, unit: "bpm", code: "bpm" };
    mount([...rows, ...hrv()]);
    const heart = await waitFor(() => cardFor("Heart rate"));
    await waitFor(() => expect(heart.textContent).toMatch(/Left out: 1 Observation with a different unit\./));
    expect(heart.textContent).toContain("1,360 samples");
  });
});
