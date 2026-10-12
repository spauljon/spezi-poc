import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { InMemoryWebStorage, WebStorageStateStore } from "oidc-client-ts";
import { describe, expect, it } from "vitest";
import { claimsOf, oidcSettings } from "../src/auth/client.ts";
import { loadConfig } from "../src/config.ts";
import { parseContract } from "../src/contract.ts";
import { config, contract } from "./support.ts";

// vitest runs from web/ (see package.json); paths are relative to it
const contractFile = resolve(process.cwd(), "../contract/metrics.json");
const raw = JSON.parse(readFileSync(contractFile, "utf8")) as {
  contractVersion: string;
  systems: { loinc: string; identifier: { patient: string } };
  metrics: { id: string; kind: string; loinc?: { code: string; display: string }; unit: { ucum: string }; stages?: Record<string, { code: string }> }[];
};

describe("contract", () => {
  it("the web app's metric list is exactly the contract's quantity metrics, with the contract's codes and units", () => {
    const expected = raw.metrics.filter((m) => m.kind === "quantity").map((m) => ({
      id: m.id, loincCode: m.loinc!.code, display: m.loinc!.display, unit: m.unit.ucum,
    }));
    expect(contract.quantityMetrics).toEqual(expected);
    expect(expected.length).toBeGreaterThanOrEqual(3);
    expect(contract.loincSystem).toBe(raw.systems.loinc);
    expect(contract.patientIdentifierSystem).toBe(raw.systems.identifier.patient);
    expect(contract.version).toBe(raw.contractVersion);
  });

  it("sleep stage codes are the contract's", () => {
    const stages = raw.metrics.find((m) => m.kind === "sleepStage")!.stages!;
    expect([...contract.sleepStageCodes].sort()).toEqual(Object.values(stages).map((s) => s.code).sort());
  });

  it("an unsupported major version is refused", () => {
    expect(() => parseContract({ ...raw, contractVersion: "2.0.0" })).toThrow(/not supported/);
  });

  it("no LOINC code or UCUM unit literal is hand-copied into src/", () => {
    const dir = `${resolve(process.cwd(), "src")}/`;
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(`${d}${e.name}/`);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(`${d}${e.name}`);
      }
    };
    walk(dir);
    const loincShape = /\b\d{3,6}-\d\b/;
    const units = raw.metrics.map((m) => m.unit.ucum).filter((u) => u.length > 1);
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(loincShape.test(text), `${file} has something shaped like a LOINC code`).toBe(false);
      for (const unit of units) {
        expect(text.includes(`"${unit}"`), `${file} has the unit literal "${unit}"`).toBe(false);
      }
    }
    expect(loincShape.test("const code = '8867-4'")).toBe(true); // control: the detector sees one
  });
});

describe("config", () => {
  const where = { origin: "https://macpro16.local:3000", hostname: "macpro16.local" };
  it("derives the issuer from the host the app was opened on and has explicit defaults", () => {
    const c = loadConfig({}, where);
    expect(c.issuer).toBe("https://macpro16.local:8444/realms/poc");
    expect(c.clientId).toBe("clinician-web");
    expect(c.redirectUri).toBe("https://macpro16.local:3000/callback");
    expect(c.fhirBase).toBe("/fhir");
    expect(c.staleAfterMinutes).toBe(30);
  });
  it("environment overrides apply, and an insecure issuer or a bad threshold is refused", () => {
    expect(loadConfig({ VITE_POC_STALE_AFTER_MINUTES: "5", VITE_POC_PATIENT_IDENTIFIER: "x" }, where))
      .toMatchObject({ staleAfterMinutes: 5, patientIdentifier: "x" });
    expect(() => loadConfig({ VITE_POC_ISSUER_URL: "http://idp.test/realms/poc" }, where)).toThrow(/https/);
    expect(() => loadConfig({ VITE_POC_STALE_AFTER_MINUTES: "0" }, where)).toThrow(/positive/);
    expect(() => loadConfig({ VITE_POC_STALE_AFTER_MINUTES: "abc" }, where)).toThrow(/positive/);
  });
});

describe("sign-in settings", () => {
  const s = oidcSettings(config);
  it("uses the authorization code flow for the registered public client", () => {
    expect(s.response_type).toBe("code");
    expect(s.client_id).toBe("clinician-web");
    expect(s.authority).toBe(config.issuer);
    expect(s.redirect_uri).toBe(config.redirectUri);
    expect(s.client_secret).toBeUndefined(); // a public client has none
  });
  it("keeps the user and tokens in memory only", () => {
    expect(s.userStore).toBeInstanceOf(WebStorageStateStore);
    const store = (s.userStore as unknown as { _store: unknown })._store;
    expect(store).toBeInstanceOf(InMemoryWebStorage);
  });
  it("renews ahead of expiry and does not fetch userinfo", () => {
    expect(s.automaticSilentRenew).toBe(true);
    expect(s.loadUserInfo).toBe(false);
  });
});

describe("claimsOf", () => {
  const token = (payload: object) =>
    `h.${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;
  it("reads the display name and roles", () => {
    expect(claimsOf(token({ preferred_username: "clinician-user", roles: ["clinician-reader", 7] })))
      .toEqual({ username: "clinician-user", roles: ["clinician-reader"] });
  });
  it("a token that is not decodable yields nothing, not an exception", () => {
    expect(claimsOf("garbage")).toEqual({ username: null, roles: [] });
    expect(claimsOf("a.!!.c")).toEqual({ username: null, roles: [] });
  });
});
