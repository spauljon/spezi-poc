import { describe, expect, it } from "vitest";
import { dayHref, flowsheetHref, parseHash, trendsHref } from "../src/route.ts";

describe("route", () => {
  it("defaults to the trends and knows the flowsheet", () => {
    expect(parseHash("")).toEqual({ view: "trends", range: null });
    expect(parseHash("#/trends")).toEqual({ view: "trends", range: null });
    expect(parseHash("#/anything-else")).toEqual({ view: "trends", range: null });
    expect(parseHash(flowsheetHref)).toEqual({ view: "flowsheet" });
  });

  it("round-trips a day with its metric and the range it came from", () => {
    const range = { from: "2026-09-13", to: "2026-10-12" };
    const href = dayHref("2026-09-25", "heartRate", range);
    expect(href).toBe("#/day/2026-09-25?metric=heartRate&from=2026-09-13&to=2026-10-12");
    expect(parseHash(href)).toEqual({ view: "day", day: "2026-09-25", metric: "heartRate", range });
    expect(trendsHref(range)).toBe("#/trends?from=2026-09-13&to=2026-10-12");
    expect(parseHash(trendsHref(range))).toEqual({ view: "trends", range });
  });

  it("works without a range", () => {
    expect(parseHash(dayHref("2026-09-25", "hrvSdnn"))).toEqual({ view: "day", day: "2026-09-25", metric: "hrvSdnn", range: null });
  });

  it.each([
    ["a day that is not a date", "#/day/2026-13-45?metric=heartRate"],
    ["a day with extra path", "#/day/2026-09-25/x"],
  ])("falls back to the trends for %s", (_n, hash) => {
    expect(parseHash(hash).view).toBe("trends");
  });

  it("ignores a malformed or inverted range and a metric that is not an identifier", () => {
    expect(parseHash("#/day/2026-09-25?metric=heartRate&from=2026-10-12&to=2026-09-13")).toMatchObject({ range: null });
    expect(parseHash("#/day/2026-09-25?metric=heartRate&from=x&to=y")).toMatchObject({ range: null });
    expect(parseHash("#/day/2026-09-25?metric=<script>")).toMatchObject({ metric: null });
  });
});
