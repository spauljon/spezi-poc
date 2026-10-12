/** `2026-10-12 14:03:07 UTC`: always explicit about the zone (time zones are never implied). */
export function formatInstantUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "unknown time";
  }
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** `12 min`, `3 h 5 min`, `2 d 4 h`. */
export function formatAge(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 1) {
    return "under a minute";
  }
  if (m < 60) {
    return `${m} min`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  }
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

export function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}
