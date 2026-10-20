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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  // the round trip rejects a date that only parses by rolling over (2026-02-30 would become 2026-03-02)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** The UTC day before `day` (`YYYY-MM-DD`). */
export function prevDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms - 86_400_000).toISOString().slice(0, 10);
}

/**
 * The day as recorded (decision D3): the calendar date written in the timestamp itself, in the offset it carries,
 * not the UTC date of the instant. `2026-10-19T23:30:00-07:00` is the 19th although it is the 20th in UTC.
 *
 * A date alone is its own day. A date-time must carry an offset (FHIR requires one when there is a time); one that
 * does not has no defined day and gives `null`, as does anything that is not a real date and instant.
 */
export function dayAsRecorded(dateTime: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(dateTime);
  const date = match?.[1];
  if (!date || !isDay(date) || !Number.isFinite(Date.parse(dateTime))) {
    return null;
  }
  return date;
}

/**
 * The UTC span that must be searched to find every entry whose day as recorded is `day`. Offsets run from UTC-12 to
 * UTC+14, so a recorded day can start as early as 10:00 UTC the day before and end as late as 12:00 UTC the day
 * after; the span is whole days around that. Callers still check each entry's own day.
 */
export function searchSpanFor(day: string): { from: string; to: string } {
  return { from: prevDay(day), to: nextDay(nextDay(day)) };
}
