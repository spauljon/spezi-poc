import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { AppUser, AuthClient } from "../src/auth/client.ts";
import { TrendsPage } from "../src/trends/TrendsPage.tsx";
import { FakeUPlot } from "./uplot-fake.ts";
import { NOW, config, contract, fakeHapi, type BandRow } from "./support.ts";

const user: AppUser = { username: "clinician-user", roles: ["clinician-reader"], expiresAt: Date.now() + 600_000 };
const client = (): AuthClient => ({
  getUser: async () => user, signIn: async () => undefined, completeSignIn: async () => user,
  accessToken: async () => "tok", signOut: async () => undefined, onSignedOut: () => () => undefined,
});

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayN = (n: number) => iso(new Date(Date.UTC(2026, 9, 12) + n * 86_400_000)); // 0 = 2026-10-12 (NOW)
const row = (day: string, median = 66, n = 1440): BandRow => ({ day, n, min: median - 15, median, max: median + 40 });
/** Heart rate for the last 10 days except two missing ones; HRV for 5; resting heart rate one value a day. */
const data: Record<string, BandRow[]> = {
  heartRate: Array.from({ length: 10 }, (_, i) => dayN(-i)).filter((d) => d !== dayN(-3) && d !== dayN(-4)).map((d) => row(d)),
  hrvSdnn: Array.from({ length: 5 }, (_, i) => row(dayN(-i), 40, 48)),
  restingHeartRate: Array.from({ length: 4 }, (_, i) => ({ day: dayN(-i), n: 1, min: 58 + i, median: 58 + i, max: 58 + i })),
};

function mount(opts: Parameters<typeof fakeHapi>[1] = {}) {
  const fake = fakeHapi([], { analytics: data, ...opts });
  vi.stubGlobal("fetch", fake);
  const view = render(
    <AuthProvider client={client()} location={{ pathname: "/", href: "https://web.test:3000/", origin: "https://web.test:3000" }} history={{ replaceState: vi.fn() }}>
      <TrendsPage config={config} contract={contract} patientId="42" now={() => NOW} />
    </AuthProvider>,
  );
  return { fake, ...view };
}
const bandsUrls = (fake: { urls: string[] }) => fake.urls.filter((u) => u.includes("/bands?"));
/** The chart cards (the page's own section is also a region, so select by class). */
const charts = () => Array.from(document.querySelectorAll<HTMLElement>("section.trend-card"));
/** The card for a metric by its display name: "Heart rate" must not also match "Heart rate --resting". */
const chartFor = (display: string | RegExp) => {
  const found = charts().find((c) => {
    const h = c.querySelector("h3")?.textContent ?? "";
    return typeof display === "string" ? h.startsWith(`${display} (`) : display.test(h);
  });
  if (!found) throw new Error(`no chart card for ${String(display)}`);
  return found;
};

beforeEach(() => FakeUPlot.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("trends", () => {
  it("shows one chart per contract metric, in the contract's order, each wearing its own slot", async () => {
    mount();
    await waitFor(() => expect(charts()).toHaveLength(contract.quantityMetrics.length));
    const names = charts().map((c) => c.querySelector("h3")!.textContent ?? "");
    contract.quantityMetrics.forEach((m, i) => {
      expect(names[i]).toContain(m.display);
      expect(names[i]).toContain(`(${m.unit})`);
      expect(charts()[i]!.querySelector(`.slot-${i + 1}`)).not.toBeNull();
    });
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(contract.quantityMetrics.length));
  });

  it("asks for the 30 UTC days that end today, for every metric", async () => {
    const { fake } = mount();
    await waitFor(() => expect(bandsUrls(fake)).toHaveLength(contract.quantityMetrics.length));
    for (const m of contract.quantityMetrics) {
      const u = bandsUrls(fake).find((x) => x.includes(`metric=${m.id}`))!;
      expect(u).toContain("/analytics/v1/patients/42/bands?");
      expect(u).toContain("from=2026-09-13");
      expect(u).toContain("to=2026-10-12");
    }
  });

  it("hands the chart null for a missing day, and the table says 'No data' for it", async () => {
    mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
    const hr = contract.quantityMetrics.findIndex((m) => m.id === "heartRate");
    const plot = FakeUPlot.instances[hr]!;
    const medians = plot.data[2] as Array<number | null>;
    const days = plot.data[0]!.length;
    expect(days).toBe(30);
    expect(medians[days - 1 - 3]).toBeNull(); // 2026-10-09
    expect(medians[days - 1 - 4]).toBeNull(); // 2026-10-08
    expect(medians[days - 1 - 2]).toBe(66); // 2026-10-10 has data: a positive control
    expect(plot.opts.series.slice(1).every((s) => s.spanGaps === false)).toBe(true);

    const card = chartFor("Heart rate");
    const table = within(card).getByRole("table", { hidden: true });
    const gap = within(table).getByRole("row", { name: /2026-10-09/, hidden: true });
    expect(gap.textContent).toContain("No data");
    const present = within(table).getByRole("row", { name: /2026-10-10/, hidden: true });
    expect(present.textContent).not.toContain("No data");
    expect(present.textContent).toContain("1440");
  });

  it("describes the gaps in words, and the days are UTC", async () => {
    mount();
    await waitFor(() => expect(charts()).toHaveLength(3));
    const card = chartFor("Heart rate");
    await waitFor(() => expect(within(card).getByText(/2026-10-08 to 2026-10-09/)).toBeTruthy());
    expect(card.textContent).toMatch(/gaps, not estimated/);
    expect(screen.getByText(/UTC calendar days/)).toBeTruthy();
  });

  it("draws a daily value (resting heart rate) as points only", async () => {
    mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
    const i = contract.quantityMetrics.findIndex((m) => m.id === "restingHeartRate");
    const plot = FakeUPlot.instances[i]!;
    expect(plot.opts.series[2]!.width).toBe(0);
    expect(plot.opts.bands).toEqual([]);
    // positive control: the heart-rate chart does have a line and a band
    const hr = FakeUPlot.instances[contract.quantityMetrics.findIndex((m) => m.id === "heartRate")]!;
    expect(hr.opts.series[2]!.width).toBe(2);
    expect(hr.opts.bands).toHaveLength(1);
  });

  it("links each day with data to the intraday route, and not the gaps", async () => {
    mount();
    await waitFor(() => expect(charts()).toHaveLength(3));
    const card = chartFor("Heart rate");
    await waitFor(() => expect(within(card).getAllByRole("link", { hidden: true }).length).toBeGreaterThan(0));
    const links = within(card).getAllByRole("link", { hidden: true }) as HTMLAnchorElement[];
    expect(links.map((l) => l.getAttribute("href"))).toContain("#/day/2026-10-12?metric=heartRate&from=2026-09-13&to=2026-10-12");
    expect(links.map((l) => l.getAttribute("href")).join(" ")).not.toContain("2026-10-09");
  });
});

describe("range controls", () => {
  it("a preset asks for that many days and re-renders every chart from the answer", async () => {
    const { fake } = mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(bandsUrls(fake).some((u) => u.includes("from=2026-10-06"))).toBe(true));
    expect(bandsUrls(fake).filter((u) => u.includes("from=2026-10-06"))).toHaveLength(3);
    expect((screen.getByRole("button", { name: "7 days" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "30 days" }).getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect((FakeUPlot.instances.at(-1)!.data[0] as ArrayLike<number>).length).toBe(7));
  });

  it("an invalid custom range explains itself and asks for nothing; a valid one does", async () => {
    const { fake } = mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
    const before = bandsUrls(fake).length;
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: "2026-10-12" } });
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: "2026-10-12" } });
    await waitFor(() => expect(bandsUrls(fake)).toHaveLength(before + 3)); // from = to is one valid day: it asked
    fireEvent.change(screen.getByLabelText(/To/), { target: { value: "2026-10-01" } });
    expect(screen.getByText(/start date is after the end date/)).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(bandsUrls(fake)).toHaveLength(before + 3); // the inverted range asked for nothing more

    // positive control: a valid range does send requests
    fireEvent.change(screen.getByLabelText(/To/), { target: { value: "2026-10-12" } });
    await waitFor(() => expect(bandsUrls(fake).length).toBe(before + 6));
    expect(bandsUrls(fake).at(-1)).toContain("from=2026-10-12");
  });

  it("holds the previous charts, dimmed, while a new range loads, and discards a superseded answer", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const { fake } = mount({
      delay: async (url) => { if (url.includes("from=2026-10-06")) await gate; },
    });
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "7 days" })); // answer held back
    await waitFor(() => expect(charts()[0]!.getAttribute("aria-busy")).toBe("true"));
    expect(charts()).toHaveLength(3); // the previous render is still there

    fireEvent.click(screen.getByRole("button", { name: "14 days" })); // supersedes the 7-day request
    await waitFor(() => expect(bandsUrls(fake).some((u) => u.includes("from=2026-09-29"))).toBe(true));
    await waitFor(() => expect(charts()[0]!.getAttribute("aria-busy")).toBe("false"));
    await act(async () => { release?.(); await gate; });
    await waitFor(() => expect((FakeUPlot.instances.at(-1)!.data[0] as ArrayLike<number>).length).toBe(14));
    expect(screen.getByText(/Showing 2026-09-29 to 2026-10-12/)).toBeTruthy();
  });
});

describe("states", () => {
  it.each([
    [503, /analytic store is not available/, true],
    [401, /sign-in was not accepted/, false],
    [403, /Not permitted/, false],
  ])("an HTTP %i answer is explained in words", async (status, text, retry) => {
    mount({ analyticsStatus: status });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(text);
    expect(!!within(alert).queryByRole("button", { name: "Try again" })).toBe(retry);
    expect(FakeUPlot.instances).toHaveLength(0); // no chart of nothing
  });

  it("an unreachable service offers a retry that loads", async () => {
    let down = true;
    mount({ failNetwork: () => down });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be reached/);
    down = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
  });

  it("an answer that is not the documented shape is an error, not a chart", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => new Response(JSON.stringify(
      String(input).includes("/v1/metrics") ? { contractVersion: "1.1.0", metrics: [] } : { surprise: true },
    ), { status: 200 })));
    render(
      <AuthProvider client={client()} location={{ pathname: "/", href: "https://web.test:3000/", origin: "https://web.test:3000" }} history={{ replaceState: vi.fn() }}>
        <TrendsPage config={config} contract={contract} patientId="42" now={() => NOW} />
      </AuthProvider>,
    );
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.textContent).join(" ")).toMatch(/not understood/);
    expect(FakeUPlot.instances).toHaveLength(0);
  });

  it("says when the worker has windows it has not recomputed yet (and nothing when it has none)", async () => {
    mount({ analyticsOver: { pendingWindows: 2 } });
    expect(await screen.findByText(/2 windows changed and not yet recomputed/)).toBeTruthy();
    cleanup();
    mount();
    await waitFor(() => expect(FakeUPlot.instances.length).toBeGreaterThan(0));
    expect(screen.queryByText(/not yet recomputed/)).toBeNull();
  });

  it("shows a disagreement between the analytic service and the contract (and none when they agree)", async () => {
    const wrong = contract.quantityMetrics.map((m) => ({ id: m.id, display: m.display, unit: m.id === "heartRate" ? "bpm" : m.unit }));
    mount({ analyticsOver: { metrics: wrong } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/heartRate/);
    expect(alert.textContent).toMatch(/unit bpm/);
    cleanup();
    mount();
    await waitFor(() => expect(FakeUPlot.instances.length).toBeGreaterThan(0));
    expect(screen.queryByText(/disagree about the metrics/)).toBeNull();
  });
});

describe("reading a day without a pointer", () => {
  it("arrow keys move the readout one day at a time, and a gap says it is a gap", async () => {
    mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
    const card = chartFor("Heart rate");
    const plot = within(card).getByRole("group", { name: /Heart rate chart/ });
    fireEvent.keyDown(plot, { key: "End" });
    expect(within(card).getByText(/^2026-10-12: median 66, range 51 to 106/)).toBeTruthy();
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(within(card).getByText(/^2026-10-11: median/)).toBeTruthy();
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    fireEvent.keyDown(plot, { key: "ArrowLeft" }); // 2026-10-09 is a gap
    expect(within(card).getByText("2026-10-09: no data (a gap, not an estimate).")).toBeTruthy();
    fireEvent.keyDown(plot, { key: "Home" });
    expect(within(card).getByText(/^2026-09-13: no data/)).toBeTruthy();
  });

  it("hovering reports the same readout as the keyboard", async () => {
    mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
    const hr = FakeUPlot.instances[contract.quantityMetrics.findIndex((m) => m.id === "heartRate")]!;
    act(() => hr.hover(29));
    expect(within(chartFor("Heart rate")).getByText(/^2026-10-12: median 66,/)).toBeTruthy();
  });

  it("destroys the chart when the view goes away", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(FakeUPlot.instances).toHaveLength(3));
    unmount();
    expect(FakeUPlot.instances.every((p) => p.destroyed)).toBe(true);
  });
});
