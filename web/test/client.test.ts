import { describe, expect, it, vi } from "vitest";
import { loadBanner } from "../src/banner/load.ts";
import { PatientLoadError, loadPatient } from "../src/patient.ts";
import { FhirClient, FhirError } from "../src/fhir/client.ts";
import { NOW, bundle, config, contract, fakeHapi, json, obs, patient, sleepObs } from "./support.ts";

const client = (fetchImpl: typeof fetch) => new FhirClient("/fhir", async () => "tok-123", fetchImpl);

describe("FhirClient", () => {
  it("sends the bearer token and asks the server not to reuse cached searches", async () => {
    const fetchImpl = vi.fn(async () => json(200, bundle([patient])));
    await client(fetchImpl as unknown as typeof fetch).search("Patient?x=1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/fhir/Patient?x=1");
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe("Bearer tok-123");
    expect(h.get("cache-control")).toBe("no-cache");
    expect(init.method).toBeUndefined(); // a plain GET: the client has no write path
  });

  it.each([
    [401, "unauthorized"], [403, "forbidden"], [500, "server"], [503, "server"], [404, "request"], [400, "request"],
  ] as const)("maps HTTP %i to %s", async (status, kind) => {
    const error = await client((async () => json(status, {})) as typeof fetch).search("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FhirError);
    expect((error as FhirError).kind).toBe(kind);
  });

  it("a network failure is a network error and never leaks the token", async () => {
    const error = await client((async () => { throw new TypeError("Failed to fetch tok-123"); }) as typeof fetch)
      .search("x").catch((e: unknown) => e) as FhirError;
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain("tok-123");
  });

  it("a body that is not JSON is a server error, not a crash", async () => {
    const error = await client((async () => new Response("<html>", { status: 200 })) as typeof fetch)
      .search("x").catch((e: unknown) => e) as FhirError;
    expect(error.kind).toBe("server");
  });

  it("resources() returns entries' resources only", async () => {
    const out = await client((async () => json(200, { resourceType: "Bundle", entry: [{ resource: { a: 1 } }, {}] })) as typeof fetch)
      .resources("x");
    expect(out).toEqual([{ a: 1 }]);
  });
});

describe("loadBanner", () => {
  const pat = { ...patient, id: "42" };

  it("asks per metric (newest by time) and once for the newest receipt, for the resolved patient", async () => {
    const hapi = fakeHapi([obs("heartRate", 72, "2026-10-12T11:50:00+00:00", "2026-10-12T11:50:05.000+00:00")]);
    const model = await loadBanner(client(hapi as unknown as typeof fetch), config, contract, NOW, pat);
    for (const m of contract.quantityMetrics) {
      const asked = hapi.urls.filter((u) => u.includes(`code=${contract.loincSystem}|${m.loincCode}`));
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("patient=Patient/42");
      expect(asked[0]).toContain("_sort=-date");
      expect(asked[0]).toContain("_count=1");
    }
    expect(hapi.urls.filter((u) => u.includes("_sort=-_lastUpdated"))).toHaveLength(1);
    expect(hapi.urls.some((u) => u.includes("$lastn") || u.includes("Patient?"))).toBe(false);
    expect(model.values.map((v) => [v.metricId, v.value])).toEqual([["heartRate", 72]]);
  });

  it("last data received counts a sleep stage the metric searches never see", async () => {
    const stage = sleepObs(contract.sleepStageCodes[0]!, "2026-10-12T11:59:00.000+00:00");
    const hapi = fakeHapi([obs("heartRate", 72, "2026-10-12T10:00:00+00:00", "2026-10-12T10:00:05.000+00:00"), stage]);
    const model = await loadBanner(client(hapi as unknown as typeof fetch), config, contract, NOW, pat);
    expect(model.lastReceivedAt).toBe("2026-10-12T11:59:00.000Z");
    expect(model.staleness.state).toBe("current");
  });

  it("a patient with no observations yields an empty banner, not an error", async () => {
    const model = await loadBanner(client(fakeHapi([]) as unknown as typeof fetch), config, contract, NOW, pat);
    expect(model.staleness.state).toBe("none");
  });
});

describe("loadPatient", () => {
  it("looks the patient up by the contract's identifier system", async () => {
    const hapi = fakeHapi([]);
    const p = await loadPatient(client(hapi as unknown as typeof fetch), config, contract);
    expect(p.id).toBe("42");
    expect(hapi.urls[0]).toContain(`identifier=${contract.patientIdentifierSystem}|poc-0001`);
  });

  it("no patient is patientNotFound; two are patientAmbiguous", async () => {
    const none = await loadPatient(client(fakeHapi([], { patients: [] }) as unknown as typeof fetch), config, contract)
      .catch((e: unknown) => e) as PatientLoadError;
    expect(none).toBeInstanceOf(PatientLoadError);
    expect(none.reason).toBe("patientNotFound");
    const two = await loadPatient(client(fakeHapi([], { patients: [patient, { ...patient, id: "43" }] }) as unknown as typeof fetch), config, contract)
      .catch((e: unknown) => e) as PatientLoadError;
    expect(two.reason).toBe("patientAmbiguous");
  });
});
