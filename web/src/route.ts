/**
 * The signed-in app's one level of navigation, held in the URL fragment so it needs no server support (the OIDC
 * callback already owns the path) and keeps the browser's back button and keyboard-operable links.
 */
export type Route =
  | { readonly view: "trends" }
  | { readonly view: "flowsheet" }
  | { readonly view: "day"; readonly day: string; readonly metric: string | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h === "/flowsheet") return { view: "flowsheet" };
  const m = /^\/day\/([^?]+)(?:\?(.*))?$/.exec(h);
  if (m && DAY.test(m[1]!)) {
    const metric = new URLSearchParams(m[2] ?? "").get("metric");
    return { view: "day", day: m[1]!, metric: metric && /^[A-Za-z0-9]+$/.test(metric) ? metric : null };
  }
  return { view: "trends" };
}

export const trendsHref = "#/trends";
export const flowsheetHref = "#/flowsheet";
export const dayHref = (day: string, metric: string): string => `#/day/${day}?metric=${encodeURIComponent(metric)}`;
