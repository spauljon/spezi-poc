import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { AppUser, AuthClient } from "../src/auth/client.ts";
import { NutritionPage } from "../src/nutrition/NutritionPage.tsx";
import { NOW, config, contract, fakeHapi, json, type NutritionRow } from "./support.ts";

const user: AppUser = { username: "clinician-user", roles: ["clinician-reader"], expiresAt: Date.now() + 600_000 };
const client = (): AuthClient => ({
  getUser: async () => user, signIn: async () => undefined, completeSignIn: async () => user,
  accessToken: async () => "tok", signOut: async () => undefined, onSignedOut: () => () => undefined,
});
const wrap = (ui: React.ReactNode) => (
  <AuthProvider client={client()} location={{ pathname: "/", href: "https://web.test:3000/", origin: "https://web.test:3000" }} history={{ replaceState: vi.fn() }}>
    {ui}
  </AuthProvider>
);

const iso = (n: number) => new Date(Date.UTC(2026, 9, 12) + n * 86_400_000).toISOString().slice(0, 10); // 0 = 2026-10-12 (NOW)
const meals = (b: number, l: number, d = 0): NutritionRow["byMeal"] => [
  { meal: "breakfast", total: b, entries: 1 }, { meal: "lunch", total: l, entries: 1 }, ...(d ? [{ meal: "dinner", total: d, entries: 1 }] : []),
];

/**
 * Energy: entries on 2026-10-12 and -10, a zero day on -09, nothing on -11 and -08. Macronutrients on 2026-10-12 only,
 * with unlabelled entries too. Fibre on one day.
 */
function data(): Record<string, NutritionRow[]> {
  return {
    dietaryEnergy: [
      { day: iso(0), byMeal: [...meals(400, 650.5, 800), { meal: "unlabelled", total: 100, entries: 1 }] },
      { day: iso(-2), byMeal: meals(300, 500), artifactSuspected: 1 },
      { day: iso(-3), byMeal: [{ meal: "unlabelled", total: 0, entries: 2 }] },
    ],
    dietaryProtein: [{ day: iso(0), byMeal: [{ meal: "unlabelled", total: 100, entries: 4 }] }],
    dietaryCarbohydrates: [{ day: iso(0), byMeal: [{ meal: "unlabelled", total: 240, entries: 4 }] }],
    dietaryFat: [{ day: iso(0), byMeal: [{ meal: "unlabelled", total: 60, entries: 4 }] }],
    dietaryFiber: [{ day: iso(-1), byMeal: [{ meal: "lunch", total: 7.5, entries: 1 }] }],
  };
}

function mount(props: Partial<React.ComponentProps<typeof NutritionPage>> = {}, opts: { rows?: Record<string, NutritionRow[]>; pending?: number } = {}) {
  const rows = opts.rows ?? data();
  const fake = fakeHapi([], { analytics: {}, analyticsOver: { nutrition: rows, pendingWindows: opts.pending ?? 0 } });
  vi.stubGlobal("fetch", fake);
  const view = render(wrap(<NutritionPage config={config} contract={contract} patientId="42" nutrient={null} now={() => NOW} {...props} />));
  return { fake, rows, ...view };
}
const nutritionUrls = (fake: { urls: string[] }) => fake.urls.filter((u) => u.includes("/nutrition?"));
const kinds = () => Object.fromEntries(Array.from(document.querySelectorAll<SVGGElement>("svg.nutrition-chart g[data-day]")).map((g) => [g.dataset["day"], g.dataset["kind"]]));
const mainTable = () => within(document.querySelector("section.trend-card details.trend-table")!).getByRole("table", { hidden: true });
const readout = () => document.querySelector(".trend-readout")!.textContent;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what is asked for", () => {
  it("the selected nutrient and the four the energy table needs, for the 30 days ending today, for this patient only", async () => {
    const { fake } = mount();
    await screen.findByText(/days have entries/);
    const urls = nutritionUrls(fake);
    expect(urls).toHaveLength(4);
    for (const id of ["dietaryEnergy", "dietaryProtein", "dietaryCarbohydrates", "dietaryFat"]) {
      const u = urls.find((x) => x.includes(`nutrient=${id}`))!;
      expect(u).toContain("/analytics/v1/patients/42/nutrition?");
      expect(u).toContain("from=2026-09-13");
      expect(u).toContain("to=2026-10-12");
    }
    expect(urls.some((u) => u.includes("dietaryFiber"))).toBe(false);
  });

  it("choosing another nutrient asks for it, wears that nutrient's contract slot, and keeps the unit", async () => {
    const { fake } = mount();
    await screen.findByText(/days have entries/);
    fireEvent.click(screen.getByRole("button", { name: "Fiber" }));
    await waitFor(() => expect(nutritionUrls(fake).some((u) => u.includes("nutrient=dietaryFiber"))).toBe(true));
    const heading = await screen.findByRole("heading", { name: /^Fiber \(g\)/ });
    const slot = contract.intakeMetrics.findIndex((m) => m.id === "dietaryFiber") + 1;
    expect(heading.querySelector(`.slot-${slot}`)).not.toBeNull();
    expect(await screen.findByText(/Fiber: 1 of 30 days have entries/)).toBeTruthy();
  });

  it("opens on the nutrient the address names", async () => {
    mount({ nutrient: "dietaryFat" });
    expect(await screen.findByRole("heading", { name: /^Fat \(g\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fat" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("a day with no entries is a gap; a total of zero is a day with entries", () => {
  it("the chart marks each differently, and the table says 'No entries' for the gap and 0 for the zero", async () => {
    mount();
    await screen.findByText(/days have entries/);
    const k = kinds();
    expect(k[iso(0)]).toBe("entries");
    expect(k[iso(-3)]).toBe("zero");
    expect(k[iso(-1)]).toBe("none");
    expect(k[iso(-4)]).toBe("none");
    // a gap draws no bar, and the zero draws a baseline mark but no bar
    const gap = document.querySelector(`g[data-day="${iso(-1)}"]`)!;
    expect(gap.querySelector(".nutrition-bar")).toBeNull();
    expect(gap.querySelector(".gap-dot")).not.toBeNull();
    const zero = document.querySelector(`g[data-day="${iso(-3)}"]`)!;
    expect(zero.querySelector(".nutrition-bar")).toBeNull();
    expect(zero.querySelector(".zero-mark")).not.toBeNull();
    expect(zero.querySelector(".gap-dot")).toBeNull();

    const table = mainTable();
    expect(within(table).getByRole("row", { name: new RegExp(iso(-1)), hidden: true }).textContent).toContain("No entries");
    const zeroRow = within(table).getByRole("row", { name: new RegExp(iso(-3)), hidden: true });
    expect(zeroRow.textContent).not.toContain("No entries");
    expect(within(zeroRow).getAllByRole("cell", { hidden: true })[0]!.textContent).toBe("0");
  });

  it("the summary is in words: days with entries, the range of those days, the zero day and the gaps, not averaged in as 0", async () => {
    mount();
    const text = (await screen.findByText(/Energy: 3 of 30 days have entries/)).textContent!;
    expect(text).toContain("ranged from 0 to 1950.5 kcal");
    expect(text).toContain("1 day sums to 0");
    expect(text).toContain("27 days have no entries");
    expect(text).toContain("not counted as 0");
  });

  it("says so when nothing at all was recorded, and draws no bar", async () => {
    mount({}, { rows: {} });
    expect(await screen.findByText(/Energy: no entries on any of these 30 days/)).toBeTruthy();
    expect(document.querySelectorAll(".nutrition-bar")).toHaveLength(0);
    expect(Object.values(kinds()).every((v) => v === "none")).toBe(true);
  });
});

describe("the keyboard", () => {
  it("arrow keys read one day at a time in words: Home, End, a gap and a day with its meals", async () => {
    mount();
    await screen.findByText(/days have entries/);
    const plot = screen.getByRole("group", { name: /Energy chart/ });
    expect(readout()).toContain("focus it and use the arrow keys");
    fireEvent.keyDown(plot, { key: "End" });
    expect(readout()).toBe(`${iso(0)}: Energy 1950.5 kcal from 4 entries; Breakfast 400, Lunch 650.5, Dinner 800, No meal recorded 100.`);
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(readout()).toBe(`${iso(-1)}: no entries (nothing recorded, not a total of 0).`);
    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    expect(readout()).toContain(`${iso(-2)}: Energy 800 kcal from 2 entries`);
    expect(readout()).toContain("flagged as a suspected artifact");
    fireEvent.keyDown(plot, { key: "Home" });
    expect(readout()).toContain(`${iso(-29)}: no entries`);
    fireEvent.keyDown(plot, { key: "ArrowLeft" }); // already first: stays
    expect(readout()).toContain(`${iso(-29)}: no entries`);
    expect(document.querySelector(".trend-readout")!.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelectorAll(".active-col")).toHaveLength(1);
  });

  it("the chart is a named, tab-focusable group", async () => {
    mount();
    await screen.findByText(/days have entries/);
    const plot = screen.getByRole("group", { name: /Energy chart/ });
    expect(plot.getAttribute("tabindex")).toBe("0");
  });
});

describe("split by meal", () => {
  it("stacks each bar by meal in the contract's order, with a key and meal columns in the table (and one bar per day when off)", async () => {
    mount();
    await screen.findByText(/days have entries/);
    expect(document.querySelectorAll(".nutrition-bar")).toHaveLength(2); // 10-12 and 10-10; the zero day has no bar
    expect(document.querySelectorAll(".nutrition-bar.meal")).toHaveLength(0);
    expect(document.querySelectorAll("ul.nutrition-key li")).toHaveLength(3); // no meals when not split: the gap, the zero and the flagged-day entries

    fireEvent.click(screen.getByRole("button", { name: "Split by meal" }));
    expect(screen.getByRole("button", { name: "Split by meal" }).getAttribute("aria-pressed")).toBe("true");
    const today = Array.from(document.querySelectorAll(`g[data-day="${iso(0)}"] .nutrition-bar.meal`)).map((r) => r.getAttribute("data-meal"));
    expect(today).toEqual(["breakfast", "lunch", "dinner", "unlabelled"]);
    const tenth = Array.from(document.querySelectorAll(`g[data-day="${iso(-2)}"] .nutrition-bar.meal`)).map((r) => r.getAttribute("data-meal"));
    expect(tenth).toEqual(["breakfast", "lunch"]);

    expect(document.querySelectorAll("ul.nutrition-key li")).toHaveLength(7); // plus the four meals present
    const key = within(screen.getByRole("list", { name: "Key" }));
    for (const label of ["Breakfast", "Lunch", "Dinner", "No meal recorded"]) expect(key.getByText(label, { exact: false })).toBeTruthy();
    expect(key.queryByText("Snack", { exact: false })).toBeNull(); // only the meals present
    const headers = within(mainTable()).getAllByRole("columnheader", { hidden: true }).map((h) => h.textContent);
    expect(headers).toEqual(["Day (as recorded)", "Total (kcal)", "Entries", "Breakfast", "Lunch", "Dinner", "No meal recorded", "Flagged", "Late"]);
    const row = within(mainTable()).getByRole("row", { name: new RegExp(iso(0)), hidden: true });
    expect(Array.from(row.querySelectorAll("td")).map((c) => c.textContent)).toEqual(["1950.5", "4", "400", "650.5", "800", "100", "0", "0"]);
  });

  it("the stacked segments are drawn to the meal totals", async () => {
    mount();
    await screen.findByText(/days have entries/);
    const heights = (split: boolean) => Array.from(document.querySelectorAll(split ? `g[data-day="${iso(0)}"] .nutrition-bar.meal` : `g[data-day="${iso(0)}"] .nutrition-bar`)).map((r) => Number(r.getAttribute("height")));
    const whole = heights(false)[0]!;
    fireEvent.click(screen.getByRole("button", { name: "Split by meal" }));
    const parts = heights(true);
    expect(parts).toHaveLength(4);
    // each segment gives up 1 px to the separator drawn between segments, so the stack adds up to the whole bar
    expect(parts.reduce((a, b) => a + b, 0) + parts.length).toBeCloseTo(whole, 0);
    expect(parts[2]!).toBeGreaterThan(parts[0]!); // dinner 800 is taller than breakfast 400
  });
});

describe("data quality", () => {
  it("states flags stored by the capture app in words, and that the totals include them", async () => {
    mount();
    const note = (await screen.findByText(/flagged as a suspected artifact/)).closest(".trend-flags")!;
    expect(note.textContent).toContain("1 entry is flagged as a suspected artifact");
    expect(note.textContent).toContain("The totals include them");
  });

  it("marks the flagged day on the chart and explains the mark in the key; no flag, no mark", async () => {
    mount();
    await screen.findByText(/days have entries/);
    expect(document.querySelectorAll("svg.nutrition-chart path[data-flag]")).toHaveLength(1);
    expect(document.querySelector(`g[data-day="${iso(-2)}"] path[data-flag]`)).not.toBeNull();
    expect(screen.getByRole("list", { name: "Key" }).textContent).toContain("Day includes a flagged entry");
    cleanup();
    const rows = data();
    rows["dietaryEnergy"]![1] = { day: iso(-2), byMeal: meals(300, 500) };
    mount({}, { rows });
    await screen.findByText(/days have entries/);
    expect(document.querySelectorAll("svg.nutrition-chart path[data-flag]")).toHaveLength(0);
    expect(screen.getByRole("list", { name: "Key" }).textContent).not.toContain("flagged entry");
  });

  it("says nothing about flags when none is stored", async () => {
    const rows = data();
    rows["dietaryEnergy"]![1] = { day: iso(-2), byMeal: meals(300, 500) };
    mount({}, { rows });
    await screen.findByText(/days have entries/);
    expect(document.querySelector(".trend-flags")).toBeNull();
  });

  it("warns that a recent window may be out of date when the worker has changes it has not recomputed", async () => {
    mount({}, { pending: 2 });
    expect(await screen.findByText(/2 windows changed and not yet recomputed/)).toBeTruthy();
  });
});

describe("energy and macronutrients, with the estimate", () => {
  it("one row per day; the shares are labelled as estimates; a nutrient with no entries is a dash that says so", async () => {
    mount();
    await screen.findByText(/days have energy entries/);
    expect(screen.getByText(/3 of 30 days have energy entries/)).toBeTruthy();
    const section = screen.getByRole("heading", { name: "Energy and macronutrients" }).closest("section")!;
    const table = within(section).getByRole("table", { hidden: true });
    const heads = within(table).getAllByRole("columnheader", { hidden: true }).map((h) => h.textContent);
    expect(heads).toEqual([
      "Day (as recorded)", "Energy (kcal)", "Protein (g)", "Carbohydrates (g)", "Fat (g)",
      "Protein share (estimate)", "Carbohydrate share (estimate)", "Fat share (estimate)",
    ]);
    const today = within(table).getByRole("row", { name: new RegExp(iso(0)), hidden: true });
    const cells = Array.from(today.querySelectorAll("td")).map((c) => c.textContent);
    // 100 g protein x4 = 400, 240 g carbs x4 = 960, 60 g fat x9 = 540, of 1950.5 kcal
    expect(cells).toEqual(["1950.5", "100", "240", "60", "21%", "49%", "28%"]);
    const noMacros = within(table).getByRole("row", { name: new RegExp(iso(-2)), hidden: true });
    expect(Array.from(noMacros.querySelectorAll("td")).map((c) => c.textContent)).toEqual([
      "800", "–no entries", "–no entries", "–no entries", "–not estimated", "–not estimated", "–not estimated",
    ]);
    expect(section.textContent).toContain("The shares are estimates, not measurements");
    expect(section.textContent).toContain("need not add up to 100%");
  });
});

describe("day as recorded, in the words on the page", () => {
  it("says which day rule applies and that it is not the UTC day of the other views", async () => {
    mount();
    await screen.findByText(/days have entries/);
    const note = screen.getByText(/days as recorded/).closest("p")!.textContent!;
    expect(note).toContain("Showing 2026-09-13 to 2026-10-12");
    expect(note).toContain("not the UTC day that Trends and Sleep use");
    expect(note).toContain("A day with no entries is an empty slot, never a total of 0");
    expect(within(mainTable()).getAllByRole("columnheader", { hidden: true })[0]!.textContent).toBe("Day (as recorded)");
    expect(document.querySelector("svg.nutrition-chart")!.textContent).toContain("Day as recorded");
  });

  it("picking 7 days asks for 7 days ending today", async () => {
    const { fake } = mount();
    await screen.findByText(/days have entries/);
    fireEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => expect(nutritionUrls(fake).some((u) => u.includes("from=2026-10-06") && u.includes("to=2026-10-12"))).toBe(true));
    await screen.findByText(/Energy: 3 of 7 days have entries/);
  });
});

describe("a retraction", () => {
  it("disappears from the totals once the worker has recomputed: Refresh shows the smaller total, and a day with nothing left is a gap", async () => {
    const { rows, fake } = mount();
    await screen.findByText(/days have entries/);
    fireEvent.keyDown(screen.getByRole("group", { name: /Energy chart/ }), { key: "End" });
    expect(readout()).toContain("Energy 1950.5 kcal from 4 entries");

    // the capture app retracted the dinner and the unlabelled entry; the worker recomputed the day
    rows["dietaryEnergy"]![0] = { day: iso(0), byMeal: meals(400, 650.5) };
    const before = nutritionUrls(fake).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(nutritionUrls(fake).length).toBeGreaterThan(before));
    await waitFor(() => expect(within(mainTable()).getByRole("row", { name: new RegExp(iso(0)), hidden: true }).textContent).toContain("1050.5"));
    expect(screen.getByText(/ranged from 0 to 1050.5 kcal/)).toBeTruthy();

    // and the last entry of a day retracted: the day is no longer a day with entries
    rows["dietaryEnergy"] = rows["dietaryEnergy"]!.filter((r) => r.day !== iso(-2));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(kinds()[iso(-2)]).toBe("none"));
    expect(within(mainTable()).getByRole("row", { name: new RegExp(iso(-2)), hidden: true }).textContent).toContain("No entries");
  });
});

describe("failures are explained, not drawn over", () => {
  it("an answer of the wrong shape is an error, and nothing is charted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { patientId: "42", nutrient: { id: "dietaryEnergy" } })));
    render(wrap(<NutritionPage config={config} contract={contract} patientId="42" nutrient={null} now={() => NOW} />));
    expect(await screen.findByText("The analytic answer was not understood")).toBeTruthy();
    expect(document.querySelector("svg.nutrition-chart")).toBeNull();
  });

  it("an unreachable service is an error with a way to try again", async () => {
    const fake = fakeHapi([], { failNetwork: () => true });
    vi.stubGlobal("fetch", fake);
    render(wrap(<NutritionPage config={config} contract={contract} patientId="42" nutrient={null} now={() => NOW} />));
    expect(await screen.findByText("The analytic service could not be reached")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.querySelector("svg.nutrition-chart")).toBeNull();
  });

  it("a contract with no intake metrics says so", () => {
    render(wrap(<NutritionPage config={config} contract={{ ...contract, intakeMetrics: [], mealTypes: [] }} patientId="42" nutrient={null} now={() => NOW} />));
    expect(screen.getByRole("alert").textContent).toContain("no dietary intake metrics");
  });
});

describe("the data set", () => {
  it("another patient's totals are fetched for that patient, and the first patient's stay off the screen while they load", async () => {
    const dataFor: Record<string, Record<string, NutritionRow[]>> = {
      "42": data(),
      "77": { dietaryEnergy: [{ day: iso(-1), byMeal: [{ meal: "unlabelled", total: 123, entries: 1 }] }] },
    };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = vi.fn(async (input: string | URL | Request) => {
      const url = decodeURIComponent(String(input));
      const who = /patients\/([^/]+)\//.exec(url)![1]!;
      if (who === "77") await gate;
      const inner = fakeHapi([], { analytics: {}, analyticsOver: { nutrition: dataFor[who]! } });
      return inner(url);
    });
    vi.stubGlobal("fetch", fake);
    const view = render(wrap(<NutritionPage config={config} contract={contract} patientId="42" nutrient={null} now={() => NOW} />));
    await screen.findByText(/Energy: 3 of 30 days have entries/);

    view.rerender(wrap(<NutritionPage config={config} contract={contract} patientId="77" nutrient={null} now={() => NOW} />));
    await waitFor(() => expect(fake.mock.calls.some(([u]) => String(u).includes("/patients/77/nutrition"))).toBe(true));
    expect(screen.queryByText(/Energy: 3 of 30 days have entries/)).toBeNull(); // patient 42's totals are gone while 77's load
    expect(await screen.findByText("Loading nutrition…")).toBeTruthy();
    await act(async () => { release(); await gate; });
    expect(await screen.findByText(/Energy: 1 of 30 days have entries/)).toBeTruthy();
    expect(within(mainTable()).getByRole("row", { name: new RegExp(iso(-1)), hidden: true }).textContent).toContain("123");
  });
});
