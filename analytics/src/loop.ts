export interface LoopOptions<R> {
  /** Time between the end of one cycle and the start of the next, when cycles succeed. */
  readonly intervalMs: number;
  /** A failing cycle is retried after `intervalMs * 2^(failures - 1)`, never more than this. */
  readonly maxBackoffMs: number;
  /** One unit of work; may throw. */
  readonly cycle: () => Promise<R>;
  readonly onResult: (result: R) => void;
  /** Receives the failure; it must never be given anything but the error (no credentials are in scope here). */
  readonly onError: (error: unknown, consecutiveFailures: number, retryInMs: number) => void;
  /** Called after EVERY attempt, success or failure: proof the loop itself is alive (a container healthcheck reads it). */
  readonly heartbeat?: () => void;
  readonly signal: AbortSignal;
  /** Resolves after `ms`, or immediately when the signal aborts. Injectable so tests do not wait. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The delay before the next attempt: the interval after a success, exponential (capped) after failures. */
export function nextDelayMs(intervalMs: number, maxBackoffMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return intervalMs;
  }
  const exponent = Math.min(consecutiveFailures - 1, 20);
  return Math.min(maxBackoffMs, intervalMs * 2 ** exponent);
}

/**
 * Runs `cycle` repeatedly until the signal aborts. A failed cycle is reported and retried with backoff: it never ends
 * the loop (a worker that dies when HAPI restarts is a worker nobody notices is dead). An abort during a cycle lets
 * that cycle finish, then stops.
 */
export async function runLoop<R>(o: LoopOptions<R>): Promise<void> {
  const sleep = o.sleep ?? abortableSleep;
  let failures = 0;
  while (!o.signal.aborted) {
    let delay: number;
    try {
      o.onResult(await o.cycle());
      failures = 0;
      delay = nextDelayMs(o.intervalMs, o.maxBackoffMs, 0);
    } catch (error) {
      failures++;
      delay = nextDelayMs(o.intervalMs, o.maxBackoffMs, failures);
      o.onError(error, failures, delay);
    }
    o.heartbeat?.();
    await sleep(delay, o.signal);
  }
}
