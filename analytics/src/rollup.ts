export interface Summary {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
}

/**
 * Count, min, median and max of finite numbers; `null` for none.
 * Median of an even count is the mean of the two middle values (an assumption, A30 in the README).
 */
export function summarize(values: readonly number[]): Summary | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return null;
  }
  const mid = n >> 1;
  const median = n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { n, min: sorted[0]!, median, max: sorted[n - 1]! };
}
