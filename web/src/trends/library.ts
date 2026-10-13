import type uPlot from "uplot";

export type ChartLibrary = typeof uPlot;

/**
 * The one place the charting library is loaded. On demand (so the sign-in page does not carry it), and behind a seam
 * because uPlot needs a canvas and `matchMedia`, which the unit-test DOM does not have: tests install a stand-in with
 * `setChartLibraryLoader` (test/setup.ts) that also records what the app asked it to draw.
 */
let loader: () => Promise<ChartLibrary> = async () => (await import("uplot")).default;

export const loadChartLibrary = (): Promise<ChartLibrary> => loader();

export function setChartLibraryLoader(next: () => Promise<ChartLibrary>): void {
  loader = next;
}
