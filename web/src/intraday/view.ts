/** The visible time window of the intraday charts, in Unix seconds (UTC). `null` means the whole day. */
export interface View {
  readonly min: number;
  readonly max: number;
}

export interface DayBounds {
  readonly start: number;
  readonly end: number;
}

const MIN_SPAN_S = 60;

/** Keeps a window inside the day without changing its width (unless it is wider than the day). */
export function clampView(v: View, day: DayBounds): View {
  const span = Math.min(Math.max(v.max - v.min, MIN_SPAN_S), day.end - day.start);
  let min = v.min;
  if (min < day.start) min = day.start;
  if (min + span > day.end) min = day.end - span;
  return { min, max: min + span };
}

/** A window of `hours` centred on the current one (or on the day's middle when showing the whole day). */
export function zoomHours(hours: number, current: View | null, day: DayBounds): View {
  const centre = current ? (current.min + current.max) / 2 : (day.start + day.end) / 2;
  const half = (hours * 3600) / 2;
  return clampView({ min: centre - half, max: centre + half }, day);
}

/** Move by half a window, earlier or later, stopping at the day's edges. */
export function pan(current: View | null, direction: -1 | 1, day: DayBounds): View | null {
  if (!current) return null;
  const shift = ((current.max - current.min) / 2) * direction;
  return clampView({ min: current.min + shift, max: current.max + shift }, day);
}

/** Whether a view is (to the second) the whole day. */
export function isWholeDay(v: View | null, day: DayBounds): boolean {
  return v === null || (Math.abs(v.min - day.start) < 1 && Math.abs(v.max - day.end) < 1);
}

/** The window a keyboard step has to show so that `t` (Unix seconds) is visible: unchanged when it already is. */
export function revealing(current: View | null, t: number, day: DayBounds): View | null {
  if (!current || (t >= current.min && t <= current.max)) return current;
  const half = (current.max - current.min) / 2;
  return clampView({ min: t - half, max: t + half }, day);
}
