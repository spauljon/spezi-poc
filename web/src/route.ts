/**
 * The signed-in app's navigation, held in the URL fragment so it needs no server support (the OIDC callback already
 * owns the path) and keeps the browser's back button and keyboard-operable links. A drill from the trends carries the
 * range it came from, so "back to trends" returns to the same view.
 */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export type Route =
  | { readonly view: "trends"; readonly range: DateRange | null }
  | { readonly view: "flowsheet" }
  | { readonly view: "day"; readonly day: string; readonly metric: string | null; readonly range: DateRange | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string | null | undefined): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

function rangeOf(q: URLSearchParams): DateRange | null {
  const from = q.get("from");
  const to = q.get("to");
  return isDay(from) && isDay(to) && from <= to ? { from, to } : null;
}

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const [path = "", query = ""] = h.split("?", 2);
  const q = new URLSearchParams(query);
  if (path === "/flowsheet") return { view: "flowsheet" };
  const m = /^\/day\/([^/]+)$/.exec(path);
  if (m && isDay(m[1])) {
    const metric = q.get("metric");
    return { view: "day", day: m[1], metric: metric && /^[A-Za-z0-9]+$/.test(metric) ? metric : null, range: rangeOf(q) };
  }
  return { view: "trends", range: path === "/trends" ? rangeOf(q) : null };
}

const rangeQuery = (range: DateRange | null | undefined): string =>
  range ? `from=${range.from}&to=${range.to}` : "";

export const flowsheetHref = "#/flowsheet";
export const trendsHref = (range?: DateRange | null): string => (range ? `#/trends?${rangeQuery(range)}` : "#/trends");
export const dayHref = (day: string, metric: string, range?: DateRange | null): string => {
  const parts = [`metric=${encodeURIComponent(metric)}`, rangeQuery(range)].filter(Boolean);
  return `#/day/${day}?${parts.join("&")}`;
};
