import { describe, expect, it } from "vitest";
import { flagLabel, qualityFlagsOf } from "../src/flags.ts";
import { contract } from "./support.ts";

const f = contract.dataQualityFlag;

describe("qualityFlagsOf", () => {
  it("reads only tags in the contract's flag system, in stored order", () => {
    const meta = { tag: [
      { system: f.system, code: f.lateArrival },
      { system: "http://example.org/other", code: f.artifactSuspected },
      { system: f.system, code: f.artifactSuspected },
    ] };
    expect(qualityFlagsOf(meta, contract)).toEqual([f.lateArrival, f.artifactSuspected]);
  });

  it("no tag, or no meta, is no flag: it never looks at a value", () => {
    expect(qualityFlagsOf(undefined, contract)).toEqual([]);
    expect(qualityFlagsOf({}, contract)).toEqual([]);
    expect(qualityFlagsOf({ tag: [] }, contract)).toEqual([]);
  });

  it("a tag without a code is ignored (the control: one with a code is kept)", () => {
    expect(qualityFlagsOf({ tag: [{ system: f.system }] }, contract)).toEqual([]);
    expect(qualityFlagsOf({ tag: [{ system: f.system, code: f.userEntered }] }, contract)).toEqual([f.userEntered]);
  });
});

describe("flagLabel", () => {
  it("every contract flag has words, and they are all different", () => {
    const labels = [f.artifactSuspected, f.duplicateResolved, f.lateArrival, f.userEntered].map((c) => flagLabel(contract, c));
    expect(new Set(labels).size).toBe(4);
    for (const label of labels) expect(label).not.toMatch(/unrecognised/);
  });

  it("a code this app does not know is shown as unrecognised, with the code, never hidden", () => {
    expect(flagLabel(contract, "something-new")).toBe('unrecognised flag "something-new"');
  });
});
