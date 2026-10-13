import { setChartLibraryLoader, type ChartLibrary } from "../src/trends/library.ts";
import { FakeUPlot } from "./uplot-fake.ts";

// uPlot needs a canvas and matchMedia, which jsdom lacks: every test gets the recording stand-in (test/uplot-fake.ts).
setChartLibraryLoader(async () => FakeUPlot as unknown as ChartLibrary);
