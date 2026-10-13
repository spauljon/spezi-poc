import assert from "node:assert/strict";
import { test } from "node:test";
import { abortableSleep, nextDelayMs, runLoop } from "../src/loop.ts";

/** A clock-free harness: `sleep` records the requested delay and aborts the loop after `max` cycles. */
function harness(outcomes: (string | Error)[], intervalMs = 30_000, maxBackoffMs = 300_000) {
  const controller = new AbortController();
  const delays: number[] = [];
  const results: string[] = [];
  const errors: { message: string; failures: number; retryInMs: number }[] = [];
  let beats = 0;
  let i = 0;
  const done = runLoop<string>({
    intervalMs, maxBackoffMs, signal: controller.signal,
    cycle: async () => {
      const outcome = outcomes[i++];
      if (outcome === undefined) throw new Error("harness ran out of outcomes");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    onResult: (r) => results.push(r),
    onError: (e, failures, retryInMs) => errors.push({ message: (e as Error).message, failures, retryInMs }),
    heartbeat: () => { beats++; },
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length >= outcomes.length) controller.abort();
    },
  });
  return { done, delays, results, errors, beats: () => beats, controller };
}

test("nextDelayMs: the interval after success, exponential after failures, capped", () => {
  assert.equal(nextDelayMs(30_000, 300_000, 0), 30_000);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 40].map((n) => nextDelayMs(30_000, 300_000, n)),
    [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

test("successful cycles repeat at the interval and each one beats", async () => {
  const h = harness(["a", "b", "c"]);
  await h.done;
  assert.deepEqual(h.results, ["a", "b", "c"]);
  assert.deepEqual(h.delays, [30_000, 30_000, 30_000]);
  assert.equal(h.beats(), 3);
  assert.deepEqual(h.errors, []);
});

test("a failing cycle is reported and retried with backoff, never ending the loop; success resets the delay", async () => {
  const h = harness([new Error("HAPI down"), new Error("HAPI down"), "ok", new Error("again"), "ok"]);
  await h.done;
  assert.deepEqual(h.delays, [30_000, 60_000, 30_000, 30_000, 30_000]);
  assert.deepEqual(h.errors.map((e) => [e.message, e.failures, e.retryInMs]),
    [["HAPI down", 1, 30_000], ["HAPI down", 2, 60_000], ["again", 1, 30_000]]);
  assert.deepEqual(h.results, ["ok", "ok"]);
  assert.equal(h.beats(), 5, "the heartbeat is written after failures too: the loop is alive");
});

test("backoff never exceeds the cap however long the outage", async () => {
  const h = harness(Array.from({ length: 12 }, () => new Error("down")), 30_000, 120_000);
  await h.done;
  assert.equal(Math.max(...h.delays), 120_000);
  assert.equal(h.delays.at(-1), 120_000);
});

test("an abort during sleep stops the loop promptly (abortableSleep resolves on abort)", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const sleeping = abortableSleep(60_000, controller.signal);
  controller.abort();
  await sleeping;
  assert.ok(Date.now() - started < 1_000);
  // and an already-aborted signal does not sleep at all
  const t = Date.now();
  await abortableSleep(60_000, controller.signal);
  assert.ok(Date.now() - t < 1_000);
});

test("an abort while a cycle is running lets that cycle finish, then stops", async () => {
  const controller = new AbortController();
  let finished = false;
  const done = runLoop<string>({
    intervalMs: 10, maxBackoffMs: 10, signal: controller.signal,
    cycle: async () => {
      controller.abort(); // asked to stop mid-cycle
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
      return "done";
    },
    onResult: () => undefined, onError: () => undefined,
  });
  await done;
  assert.equal(finished, true);
});

test("the error handler receives only the error object (nothing from the environment)", async () => {
  process.env["POC_TEST_SECRET"] = "should-never-appear";
  const h = harness([new Error("connect ECONNREFUSED 10.0.0.1:1521")]);
  await h.done;
  assert.ok(!JSON.stringify(h.errors).includes("should-never-appear"));
  delete process.env["POC_TEST_SECRET"];
});
