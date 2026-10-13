import { describe, expect, it } from "vitest";
import { buildBanner } from "../src/banner/model.ts";
import { formatAge, formatInstantUtc, formatValue } from "../src/format.ts";
import { NOW, contract, obs, patient, sleepObs } from "./support.ts";

const MIN = 60_000;
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * MIN).toISOString();

describe("buildBanner", () => {
  it("takes the latest value per metric by the sample's own time", () => {
    const model = buildBanner(patient, [
      obs("heartRate", 70, ago(20), ago(19)),
      obs("heartRate", 88, ago(5), ago(4)),
      obs("hrvSdnn", 42, ago(60), ago(59)),
    ], contract, NOW, 30);
    expect(model.values.map((v) => [v.metricId, v.value])).toEqual([["heartRate", 88], ["hrvSdnn", 42]]);
    expect(model.missing.map((m) => m.metricId)).toEqual(["restingHeartRate"]);
  });

  it("units and display text come from the contract, not from the resource", () => {
    const model = buildBanner(patient, [obs("heartRate", 70, ago(5), ago(4))], contract, NOW, 30);
    const hr = model.values[0]!;
    expect(hr.unit).toBe(contract.quantityMetrics.find((m) => m.id === "heartRate")!.unit);
    expect(hr.display).toBe(contract.quantityMetrics.find((m) => m.id === "heartRate")!.display);
  });

  it("last data received is the newest server receipt over everything, sleep stages included", () => {
    const stage = contract.sleepStageCodes[0]!;
    const model = buildBanner(patient, [
      obs("heartRate", 70, ago(120), ago(100)),
      sleepObs(stage, ago(10)),
    ], contract, NOW, 30);
    expect(model.lastReceivedAt).toBe(ago(10));
    expect(model.staleness).toEqual({ state: "current", ageMinutes: 10, thresholdMinutes: 30 });
  });

  it("staleness: exactly the threshold is current, one minute over is stale", () => {
    const at = (m: number) => buildBanner(patient, [obs("heartRate", 70, ago(m), ago(m))], contract, NOW, 30).staleness.state;
    expect(at(30)).toBe("current");
    expect(at(31)).toBe("stale");
    expect(at(0)).toBe("current");
  });

  it("staleness is by when the server received data, not when it was measured", () => {
    // measured yesterday, delivered a minute ago (a late batch): the connection is alive, so not stale
    const model = buildBanner(patient, [obs("heartRate", 70, ago(1500), ago(1))], contract, NOW, 30);
    expect(model.staleness.state).toBe("current");
  });

  it("no observations at all is 'none', distinct from stale, with every metric reported missing", () => {
    const model = buildBanner(patient, [], contract, NOW, 30);
    expect(model.staleness).toEqual({ state: "none" });
    expect(model.lastReceivedAt).toBeNull();
    expect(model.values).toEqual([]);
    expect(model.missing).toHaveLength(contract.quantityMetrics.length);
    expect(model.sources).toEqual([]);
  });

  it("source kinds come from meta.source via the contract; anything else is shown as unknown, not dropped", () => {
    const model = buildBanner(patient, [
      obs("heartRate", 70, ago(5), ago(4), "synthetic"),
      obs("hrvSdnn", 40, ago(5), ago(4), "healthKit"),
      obs("restingHeartRate", 55, ago(5), ago(4), "http://elsewhere.example/source"),
    ], contract, NOW, 30);
    expect(model.sources).toEqual(["synthetic", "healthKit", "unknown"]);
    expect(model.values.find((v) => v.metricId === "restingHeartRate")!.source).toBe("unknown");
  });

  it("HAPI's '#<request id>' suffix on meta.source does not hide the source (seen on every stored resource)", () => {
    const stored = obs("heartRate", 70, ago(5), ago(4), `${contract.metaSource.synthetic}#QHpCc4VhJA80HQOm`);
    const noUri = obs("hrvSdnn", 40, ago(5), ago(4), "#tndW9BkQ8MgJ3H4k");
    const model = buildBanner(patient, [stored, noUri], contract, NOW, 30);
    expect(model.values.find((v) => v.metricId === "heartRate")!.source).toBe("synthetic");
    expect(model.values.find((v) => v.metricId === "hrvSdnn")!.source).toBe("unknown");
    expect(model.sources).toEqual(["synthetic", "unknown"]);
    // a look-alike URI that only starts with the contract's is not the contract's
    const lookalike = obs("restingHeartRate", 50, ago(5), ago(4), `${contract.metaSource.synthetic}-evil#x`);
    expect(buildBanner(patient, [lookalike], contract, NOW, 30).values[0]!.source).toBe("unknown");
  });

  it("a receipt time ahead of the clock is reported and the age is clamped to zero", () => {
    const future = new Date(NOW.getTime() + 5 * MIN).toISOString();
    const model = buildBanner(patient, [obs("heartRate", 70, ago(1), future)], contract, NOW, 30);
    expect(model.timestampInFuture).toBe(true);
    expect(model.staleness).toEqual({ state: "current", ageMinutes: 0, thresholdMinutes: 30 });
  });

  it("an observation with no numeric value or no time is not a latest value", () => {
    const noValue = obs("heartRate", 70, ago(5), ago(4));
    delete noValue.valueQuantity!.value;
    const noTime = obs("hrvSdnn", 40, "not a time", ago(4));
    const model = buildBanner(patient, [noValue, noTime], contract, NOW, 30);
    expect(model.values).toEqual([]);
  });

  it("patient name and the business identifier come from the Patient", () => {
    const model = buildBanner(patient, [], contract, NOW, 30);
    expect(model.patientName).toBe("Poc Synthetic");
    expect(model.patientIdentifier).toBe("poc-0001");
    expect(buildBanner({ resourceType: "Patient" }, [], contract, NOW, 30).patientName).toBe("Unnamed patient");
  });
});

describe("format", () => {
  it("formats instants with an explicit zone", () => {
    expect(formatInstantUtc("2026-10-12T14:03:07.123+02:00")).toBe("2026-10-12 12:03:07 UTC");
    expect(formatInstantUtc("nope")).toBe("unknown time");
  });
  it("formats ages", () => {
    expect([0.4, 1, 59, 60, 65, 24 * 60, 25 * 60 + 5, 49 * 60].map(formatAge)).toEqual(
      ["under a minute", "1 min", "59 min", "1 h", "1 h 5 min", "1 d", "1 d 1 h", "2 d 1 h"]);
  });
  it("formats values without trailing noise", () => {
    expect([72, 72.5, 41.237, 0.1 + 0.2].map(formatValue)).toEqual(["72", "72.5", "41.24", "0.3"]);
  });
});
