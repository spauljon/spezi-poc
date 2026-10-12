import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadContract } from "../src/contract.ts";

const contractFile = fileURLToPath(new URL("../../contract/metrics.json", import.meta.url));
const raw = JSON.parse(readFileSync(contractFile, "utf8")) as {
  contractVersion: string;
  systems: { loinc: string; ucum: string };
  metrics: { id: string; kind: string; loinc?: { code: string; display: string }; unit: { ucum: string } }[];
};

test("the worker's metric list is exactly the contract's quantity metrics, with the contract's codes and units", () => {
  const c = loadContract();
  const expected = raw.metrics.filter((m) => m.kind === "quantity").map((m) => ({
    id: m.id, loincCode: m.loinc!.code, ucum: m.unit.ucum, display: m.loinc!.display,
  }));
  assert.deepEqual([...c.quantityMetrics], expected);
  assert.equal(c.loincSystem, raw.systems.loinc);
  assert.equal(c.ucumSystem, raw.systems.ucum);
  assert.equal(c.version, raw.contractVersion);
  assert.ok(expected.length >= 3);
});

test("sleep-stage metrics are not in the rollup list", () => {
  const ids = loadContract().quantityMetrics.map((m) => m.id);
  assert.ok(raw.metrics.some((m) => m.kind !== "quantity"), "control: the contract has a non-quantity metric");
  for (const m of raw.metrics.filter((x) => x.kind !== "quantity")) {
    assert.ok(!ids.includes(m.id));
  }
});

test("no LOINC code or UCUM unit literal is hand-copied into the worker's source", () => {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const loincShape = /\b\d{3,6}-\d\b/;
  const units = raw.metrics.map((m) => m.unit.ucum).filter((u) => u.length > 1);
  let checked = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(`${dir}${file}`, "utf8");
    checked++;
    assert.ok(!loincShape.test(text), `${file} contains something shaped like a LOINC code`);
    for (const unit of units) {
      assert.ok(!text.includes(`"${unit}"`), `${file} contains the unit literal "${unit}"`);
    }
  }
  assert.ok(checked >= 8);
  // positive control: the detector does see a code when there is one
  assert.ok(loincShape.test("const code = '8867-4'"));
});

test("an unsupported contract major version is refused", () => {
  const dir = fileURLToPath(new URL("./", import.meta.url));
  void dir;
  assert.throws(() => loadContract(fileURLToPath(new URL("fixtures/contract-v2.json", import.meta.url))), /not supported/);
});

test("a contract with a quantity metric lacking a unit is refused", () => {
  assert.throws(() => loadContract(fileURLToPath(new URL("fixtures/contract-no-unit.json", import.meta.url))), /lacks a code or unit/);
});
