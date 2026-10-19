import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { AppUser, AuthClient } from "../src/auth/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { Flowsheet } from "../src/flowsheet/Flowsheet.tsx";
import { config, contract, fakeHapi, obs, sleepObs } from "./support.ts";

const user: AppUser = { username: "clinician-user", roles: ["clinician-reader"], expiresAt: Date.now() + 600_000 };
const client = (): AuthClient => ({
  getUser: async () => user, signIn: async () => undefined, completeSignIn: async () => user,
  accessToken: async () => "tok", signOut: async () => undefined, onSignedOut: () => () => undefined,
});

const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000).toISOString();
/** `count` heart-rate observations a minute apart, newest last; value cycles so sorting by value is visible. */
function series(count: number, metricId = "heartRate", source = "synthetic"): Observation[] {
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(Date.parse(day(0)) + i * 60_000).toISOString();
    const o = obs(metricId, 50 + (i % 40), t, t, source);
    o.id = `${metricId}-${String(i).padStart(4, "0")}`;
    return o;
  });
}

function mount(observations: Observation[], opts: Parameters<typeof fakeHapi>[1] = {}) {
  const fake = fakeHapi(observations, opts);
  vi.stubGlobal("fetch", fake);
  render(
    <AuthProvider client={client()} location={{ pathname: "/", href: "https://web.test:3000/", origin: "https://web.test:3000" }} history={{ replaceState: vi.fn() }}>
      <Flowsheet config={config} contract={contract} patientId="42" />
    </AuthProvider>,
  );
  return fake;
}

const lastUrl = (fake: { urls: string[] }) => fake.urls[fake.urls.length - 1]!;
const rowsText = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) => r.textContent ?? "");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("flowsheet", () => {
  it("shows the first page, the window and the total, newest first, units beside values", async () => {
    mount(series(60));
    expect(await screen.findByText("Rows 1 to 25 of 60")).toBeTruthy();
    expect(rowsText()).toHaveLength(25);
    expect(rowsText()[0]).toContain("UTC");
    expect(rowsText()[0]).toContain("/min");
    const dates = rowsText().map((t) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/.exec(t)![0]);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("paging asks for the next window and walks every row exactly once", async () => {
    const fake = mount(series(60));
    await screen.findByText("Rows 1 to 25 of 60");
    const seen = new Set<string>();
    const collect = () => rowsText().forEach((t) => seen.add(t));
    collect();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Rows 26 to 50 of 60");
    expect(lastUrl(fake)).toContain("_offset=25");
    collect();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Rows 51 to 60 of 60");
    collect();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(seen.size).toBe(60);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("Rows 26 to 50 of 60");
  });

  it("a filter change returns to the first page", async () => {
    mount([...series(60), ...series(10, "hrvSdnn")]);
    await screen.findByText(/of 70/);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Rows 26 to 50 of 70");
    fireEvent.change(screen.getByLabelText("Rows per page"), { target: { value: "50" } });
    await screen.findByText("Rows 1 to 50 of 70");
  });

  it("unchecking a metric re-queries with that metric's code removed and the total follows", async () => {
    const fake = mount([...series(30), ...series(12, "hrvSdnn")]);
    await screen.findByText("Rows 1 to 25 of 42");
    const hrv = contract.quantityMetrics.find((m) => m.id === "hrvSdnn")!;
    fireEvent.click(screen.getByLabelText(contract.quantityMetrics.find((m) => m.id === "heartRate")!.display));
    await screen.findByText(/of 12$/);
    expect(decodeURIComponent(lastUrl(fake))).not.toContain("|" + contract.quantityMetrics.find((m) => m.id === "heartRate")!.loincCode);
    expect(decodeURIComponent(lastUrl(fake))).toContain(`|${hrv.loincCode}`);
  });

  it("date range, source and status filters reach the server and narrow the result", async () => {
    const stale = series(5, "heartRate", "healthKit");
    const prelim = series(3);
    prelim.forEach((o) => { o.status = "preliminary"; o.id = `p-${o.id}`; });
    const fake = mount([...series(20), ...stale, ...prelim]);
    await screen.findByText(/of 28/);
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "healthKit" } });
    await screen.findByText(/of 5$/);
    expect(decodeURIComponent(lastUrl(fake))).toContain(`_source=${contract.metaSource.healthKit}`);
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "any" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "preliminary" } });
    await screen.findByText(/of 3$/);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "any" } });
    fireEvent.change(screen.getByLabelText("From (UTC date)"), { target: { value: "2026-10-02" } });
    await screen.findByText("No observations match these filters.");
    expect(decodeURIComponent(lastUrl(fake))).toContain("date=ge2026-10-02T00:00:00Z");
  });

  it("an empty result is a message with a way back, not a blank table", async () => {
    mount(series(5));
    await screen.findByText(/of 5$/);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "amended" } });
    expect(await screen.findByText("No observations match these filters.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await screen.findByText(/of 5$/);
  });

  it("sort headers: aria-sort follows, the first click uses a sensible direction, a second click reverses", async () => {
    const fake = mount(series(40));
    await screen.findByText(/of 40/);
    const measured = screen.getByRole("columnheader", { name: /Measured/ });
    expect(measured.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(within(measured).getByRole("button"));
    await waitFor(() => expect(measured.getAttribute("aria-sort")).toBe("ascending"));
    expect(decodeURIComponent(lastUrl(fake))).toContain("_sort=date,_id");

    const value = screen.getByRole("columnheader", { name: /Value/ });
    fireEvent.click(within(value).getByRole("button"));
    await waitFor(() => expect(value.getAttribute("aria-sort")).toBe("ascending"));
    expect(measured.getAttribute("aria-sort")).toBe("none");
    expect(decodeURIComponent(lastUrl(fake))).toContain("_sort=value-quantity,_id");
    const values = () => rowsText().map((t) => Number(/(\d+(?:\.\d+)?) \/min/.exec(t)![1]));
    await waitFor(() => expect(values()).toEqual([...values()].sort((a, b) => a - b)));
    fireEvent.click(within(value).getByRole("button"));
    await waitFor(() => expect(value.getAttribute("aria-sort")).toBe("descending"));
    await waitFor(() => expect(values()).toEqual([...values()].sort((a, b) => b - a)));
  });

  it("source is not a sortable column (the server does not order it reliably)", async () => {
    mount(series(3));
    await screen.findByText(/of 3$/);
    const source = screen.getByRole("columnheader", { name: "Source" });
    expect(within(source).queryByRole("button")).toBeNull();
    expect(source.getAttribute("aria-sort")).toBeNull();
  });

  it("flags non-final status and strikes entered-in-error rows, never hiding them", async () => {
    const a = series(3);
    a[0]!.status = "entered-in-error";
    a[1]!.status = "preliminary";
    mount(a);
    await screen.findByText(/of 3$/);
    const text = rowsText().join("|");
    expect(text).toContain("entered-in-error");
    expect(text).toContain("preliminary");
    expect(document.querySelectorAll("tr.in-error")).toHaveLength(1);
  });

  it("sleep stages show their period and minutes; unknown codes and unit mismatches stay visible", async () => {
    const stage = sleepObs(contract.sleepStages[0]!.loincCode, "2026-10-12T02:00:00.000+00:00");
    stage.id = "stage-1";
    const mismatch = series(1)[0]!;
    mismatch.id = "mismatch";
    mismatch.valueQuantity = { value: 70, code: "mm[Hg]" };
    mount([stage, mismatch]);
    await screen.findByText(/of 2$/);
    const text = rowsText().join("|");
    expect(text).toContain(contract.sleepStages[0]!.display);
    expect(text).toContain("to 2026-10-12 02:00:00 UTC");
    expect(text).toContain("unit differs: mm[Hg]");
  });

  it("an inverted date range is explained and no request is made for it", async () => {
    const fake = mount(series(5));
    await screen.findByText(/of 5$/);
    const calls = fake.mock.calls.length;
    fireEvent.change(screen.getByLabelText("From (UTC date)"), { target: { value: "2026-10-09" } });
    await screen.findByText(/of 0|No observations/);
    fireEvent.change(screen.getByLabelText("To (UTC date, inclusive)"), { target: { value: "2026-10-01" } });
    expect(await screen.findByText("The start date is after the end date.")).toBeTruthy();
    const after = fake.mock.calls.length;
    expect(after).toBe(calls + 1); // the From change queried; the inverted pair did not
  });

  it("a slow older response never replaces a newer one", async () => {
    // A: status=preliminary (5 rows) is held back. B: the same plus source=healthKit (2 rows) answers first.
    const syntheticPrelim = series(3).map((o) => ({ ...o, status: "preliminary", id: `s-${o.id}` }));
    const hkPrelim = series(2, "heartRate", "healthKit").map((o) => ({ ...o, status: "preliminary", id: `h-${o.id}` }));
    let releaseA: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { releaseA = resolve; });
    const fake = mount([...series(20), ...syntheticPrelim, ...hkPrelim], {
      delay: (url) => (url.includes("status=preliminary") && !url.includes("_source=") ? held : Promise.resolve()),
    });
    await screen.findByText(/of 25$/);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "preliminary" } }); // A, held
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "healthKit" } });   // B, answers first
    await screen.findByText(/of 2$/);
    await act(async () => { releaseA(); await held; });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/of 2$/)).toBeTruthy(); // A's "of 5" must not have replaced it
    expect(screen.queryByText(/of 5$/)).toBeNull();
    expect(fake.urls.filter((u) => u.includes("status=preliminary") && !u.includes("_source="))).toHaveLength(1);
  });

  it("a server error is explained with a retry that works", async () => {
    let fail = true;
    mount(series(4), { failNetwork: () => fail });
    expect(await screen.findByText("The server could not be reached")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(/of 4$/);
  });

  it("thousands of rows: the table renders one page, the total is the server's", async () => {
    mount(series(4000));
    expect(await screen.findByText("Rows 1 to 25 of 4,000")).toBeTruthy();
    expect(rowsText()).toHaveLength(25);
    expect(screen.getByText("Page 1 of 160")).toBeTruthy();
  });

  it("shows each row's stored flags in words, 'none stored' when there are none, and never flags a value by how it looks", async () => {
    const f = contract.dataQualityFlag;
    const t = (n: number) => new Date(Date.parse(day(0)) + n * 60_000).toISOString();
    const make = (n: number, value: number, tags: Array<{ system: string; code: string }> | undefined) => {
      const o = obs("heartRate", value, t(n), t(n));
      o.id = `flag-${n}`;
      if (tags) o.meta = { ...o.meta, tag: tags };
      return o;
    };
    mount([
      make(0, 300, undefined), // absurd and unflagged: no flag appears
      make(1, 72, [{ system: f.system, code: f.lateArrival }]),
      make(2, 281, [{ system: f.system, code: f.artifactSuspected }, { system: f.system, code: f.lateArrival }]),
      make(3, 70, [{ system: "http://example.org/other", code: f.artifactSuspected }]), // not our system: not a flag
      make(4, 70, [{ system: f.system, code: "brand-new" }]),
    ]);
    await screen.findByText("Rows 1 to 5 of 5");
    const byValue = (needle: string) => rowsText().find((r) => r.includes(needle)) ?? "";
    expect(byValue("300")).toContain("none stored");
    expect(byValue("300")).not.toMatch(/artifact suspected|late arrival/);
    expect(byValue("72")).toContain("late arrival");
    expect(byValue("281")).toContain("artifact suspected, late arrival");
    const others = rowsText().filter((r) => r.includes("none stored"));
    expect(others.length).toBe(2); // the absurd one and the other-system one
    expect(rowsText().some((r) => r.includes('unrecognised flag "brand-new"'))).toBe(true);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toContain("Flags");
  });
});

