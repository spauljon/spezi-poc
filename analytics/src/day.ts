/**
 * The rollup day is the UTC calendar date of the sample's instant (assumption A6, decided by the developer):
 * patients cross time zones and DST, so a fixed reference keeps every sample's day stable and reproducible.
 * Returns `YYYY-MM-DD`, or `null` when the value is not a usable instant.
 */
export function utcDay(dateTime: string): string | null {
  const ms = Date.parse(dateTime);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/** The UTC day after `day` (`YYYY-MM-DD`). */
export function nextDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms + 86_400_000).toISOString().slice(0, 10);
}

export function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}
