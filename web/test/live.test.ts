// @vitest-environment node
import { describe, expect, it } from "vitest";
import { reevaluate } from "../src/banner/BannerPage.tsx";
import { loadBanner } from "../src/banner/load.ts";
import { FhirClient } from "../src/fhir/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { config, contract } from "./support.ts";

/**
 * Read-only check of the banner's data path against the live POC HAPI with a real clinician token. Skipped (and
 * reported skipped) unless POC_WEB_LIVE=1: run `make test-web-live`, which supplies the password from the git-ignored
 * idp/.env.local and trusts the POC CA. It writes nothing.
 */
const live = process.env["POC_WEB_LIVE"] === "1";
const issuer = process.env["POC_ISSUER_URL"] ?? "https://macpro16.local:8444/realms/poc";
const fhirBase = process.env["POC_FHIR_URL"] ?? "https://macpro16.local:8443/fhir";

async function clinicianToken(): Promise<string> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password", client_id: "poc-devtest", username: "clinician-user",
      password: process.env["POC_CLINICIAN_USER_PASSWORD"] ?? "",
    }),
  });
  if (response.status !== 200) throw new Error(`token request failed (HTTP ${response.status}); is the stack up?`);
  return ((await response.json()) as { access_token: string }).access_token;
}

describe.skipIf(!live)("banner against the live HAPI", () => {
  it("shows the latest value per metric, as an independent sorted search finds it, and the staleness follows the clock", async () => {
    const token = await clinicianToken();
    const client = new FhirClient(fhirBase, async () => token);
    const live = { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" };
    const model = await loadBanner(client, live, contract, new Date());

    expect(model.patientIdentifier).toBe(live.patientIdentifier);
    expect(model.values.length).toBeGreaterThan(0); // the stack has synthetic data (M8, M9 live runs)

    // Independent: read EVERY Observation of the metric (paged, unsorted) and take the newest in this process,
    // so the check does not rely on the server's sort that the app itself uses.
    const patientId = (await client.resources<{ id: string }>(
      `Patient?identifier=${encodeURIComponent(`${contract.patientIdentifierSystem}|${live.patientIdentifier}`)}`))[0]!.id;
    const readAll = async (first: string): Promise<Observation[]> => {
      const out: Observation[] = [];
      let url: string | null = first;
      for (let page = 0; url && page < 200; page++) {
        const response: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" } });
        const body = (await response.json()) as { entry?: { resource: Observation }[]; link?: { relation: string; url: string }[] };
        out.push(...(body.entry ?? []).map((e) => e.resource));
        url = body.link?.find((l) => l.relation === "next")?.url ?? null;
      }
      return out;
    };
    for (const v of model.values) {
      const metric = contract.quantityMetrics.find((m) => m.id === v.metricId)!;
      const code = encodeURIComponent(`${contract.loincSystem}|${metric.loincCode}`);
      const all = await readAll(
        `${fhirBase}/Observation?patient=Patient/${patientId}&code=${code}&_count=200&_elements=effectiveDateTime,valueQuantity`);
      const newest = Math.max(...all.map((o) => Date.parse(o.effectiveDateTime ?? "")));
      expect(Date.parse(v.effective)).toBe(newest);
      const valuesAtNewest = all.filter((o) => Date.parse(o.effectiveDateTime ?? "") === newest).map((o) => o.valueQuantity?.value);
      expect(valuesAtNewest).toContain(v.value);
      expect(v.unit).toBe(metric.unit);
    }

    // "Last data received" is the newest server receipt over everything for this patient.
    const everything = await readAll(`${fhirBase}/Observation?patient=Patient/${patientId}&_count=200&_elements=meta`);
    const newestReceipt = Math.max(...everything.map((o) => Date.parse(o.meta?.lastUpdated ?? "")));
    expect(Date.parse(model.lastReceivedAt as string)).toBe(newestReceipt);

    // Staleness follows the clock (the same stored model, evaluated at different times).
    const received = Date.parse(model.lastReceivedAt as string);
    const at = (minutes: number) => reevaluate(model, received + minutes * 60_000, config.staleAfterMinutes).staleness.state;
    expect(at(1)).toBe("current");
    expect(at(config.staleAfterMinutes + 1)).toBe("stale");
    // and the data on the server is old enough, or recent enough, that the banner says so truthfully right now
    expect(model.staleness.state).toBe(Date.now() - received > config.staleAfterMinutes * 60_000 ? "stale" : "current");
  });
});
