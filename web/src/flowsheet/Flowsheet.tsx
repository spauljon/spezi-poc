import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import { explainError, type Explained } from "../explain.ts";
import { FhirClient } from "../fhir/client.ts";
import type { Observation } from "../fhir/types.ts";
import { formatInstantUtc, formatValue } from "../format.ts";
import {
  OBSERVATION_STATUSES, PAGE_SIZES, SORT_COLUMNS, buildSearch, defaultQuery, flowMetrics, validateQuery,
  type FlowQuery, type SortColumn, type SourceFilter,
} from "./query.ts";
import { toRow, type FlowRow } from "./rows.ts";

const SOURCE_LABEL = { synthetic: "Synthetic simulator", healthKit: "HealthKit", unknown: "Unknown source" } as const;
const HEADERS: Record<SortColumn, string> = {
  measured: "Measured (UTC)", metric: "Metric", value: "Value", status: "Status", received: "Received by server (UTC)",
};

type Load =
  | { readonly kind: "loading"; readonly previous: Page | null }
  | { readonly kind: "ready"; readonly page: Page }
  | { readonly kind: "error"; readonly error: Explained };

interface Page {
  readonly rows: readonly FlowRow[];
  readonly total: number;
}

/**
 * The flowsheet: every filter, the order, the page window and the total are the server's work, so the table stays
 * correct over thousands of rows. A response that arrives after a newer request was made is discarded.
 */
export function Flowsheet({ config, contract, patientId }: { config: WebConfig; contract: WebContract; patientId: string }) {
  const auth = useAuth();
  const [query, setQuery] = useState<FlowQuery>(defaultQuery);
  const [load, setLoad] = useState<Load>({ kind: "loading", previous: null });
  const [reloads, setReloads] = useState(0);
  const latest = useRef(0);
  const metrics = useMemo(() => flowMetrics(contract), [contract]);
  const problem = validateQuery(query);
  const ids = { from: useId(), to: useId(), source: useId(), status: useId(), size: useId() };

  const path = useMemo(() => (problem ? null : buildSearch(query, patientId, contract)), [query, patientId, contract, problem]);

  useEffect(() => {
    if (path === null) {
      return;
    }
    const ticket = ++latest.current;
    setLoad((prev) => ({ kind: "loading", previous: prev.kind === "ready" ? prev.page : prev.kind === "loading" ? prev.previous : null }));
    const client = new FhirClient(config.fhirBase, () => auth.accessToken());
    client.search<Observation>(path).then(
      (bundle) => {
        if (ticket !== latest.current) return; // a newer request superseded this one
        const rows = (bundle.entry ?? []).flatMap((e) => (e.resource ? [toRow(e.resource, contract)] : []));
        setLoad({ kind: "ready", page: { rows, total: bundle.total ?? rows.length } });
      },
      (error: unknown) => {
        if (ticket !== latest.current) return;
        setLoad({ kind: "error", error: explainError(error) });
      },
    );
  }, [path, config.fhirBase, contract, auth, reloads]);

  const change = useCallback((patch: Partial<FlowQuery>) => {
    // any filter or size change goes back to the first page; only paging itself keeps the window
    setQuery((q) => ({ ...q, page: 0, ...patch }));
  }, []);

  const shown = load.kind === "ready" ? load.page : load.kind === "loading" ? load.previous : null;
  const total = shown?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const first = total === 0 ? 0 : query.page * query.pageSize + 1;
  const last = Math.min(total, (query.page + 1) * query.pageSize);
  const filtered = query.metrics.length > 0 || query.from !== null || query.to !== null || query.source !== "any" || query.status !== "any";

  const toggleMetric = (key: string) => {
    const chosen = query.metrics.length === 0 ? metrics.map((m) => m.key) : [...query.metrics];
    const next = chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key];
    // none selected would mean "no metric"; treat all-or-none as "every contract metric"
    change({ metrics: next.length === metrics.length ? [] : next });
  };
  const checked = (key: string) => query.metrics.length === 0 || query.metrics.includes(key);

  const sortBy = (column: SortColumn) => {
    const same = query.sort.column === column;
    change({ sort: { column, direction: same && query.sort.direction === "asc" ? "desc" : same ? "asc" : column === "measured" || column === "received" ? "desc" : "asc" } });
  };
  const ariaSort = (column: SortColumn) =>
    query.sort.column !== column ? "none" : query.sort.direction === "asc" ? "ascending" : "descending";

  return (
    <section aria-labelledby="flowsheet-title" className="flowsheet">
      <h3 id="flowsheet-title">Observations</h3>

      <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Flowsheet filters">
        <fieldset>
          <legend>Metrics</legend>
          {metrics.map((m) => (
            <label key={m.key} className="check">
              <input type="checkbox" checked={checked(m.key)} onChange={() => toggleMetric(m.key)} /> {m.display}
            </label>
          ))}
        </fieldset>
        <div className="field-row">
          <label htmlFor={ids.from}>From (UTC date)</label>
          <input id={ids.from} type="date" value={query.from ?? ""} onChange={(e) => change({ from: e.target.value || null })} />
          <label htmlFor={ids.to}>To (UTC date, inclusive)</label>
          <input id={ids.to} type="date" value={query.to ?? ""} onChange={(e) => change({ to: e.target.value || null })} />
        </div>
        <div className="field-row">
          <label htmlFor={ids.source}>Source</label>
          <select id={ids.source} value={query.source} onChange={(e) => change({ source: e.target.value as SourceFilter })}>
            <option value="any">Any source</option>
            <option value="synthetic">Synthetic simulator</option>
            <option value="healthKit">HealthKit</option>
          </select>
          <label htmlFor={ids.status}>Status</label>
          <select id={ids.status} value={query.status} onChange={(e) => change({ status: e.target.value })}>
            <option value="any">Any status</option>
            {OBSERVATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <label htmlFor={ids.size}>Rows per page</label>
          <select id={ids.size} value={query.pageSize} onChange={(e) => change({ pageSize: Number(e.target.value) })}>
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {filtered && <button type="button" onClick={() => setQuery({ ...defaultQuery, sort: query.sort, pageSize: query.pageSize })}>Clear filters</button>}
        </div>
        {problem && <p role="alert" className="state-error">{problem}</p>}
      </form>

      {load.kind === "error" && (
        <div role="alert" className="state state-error">
          <h4>{load.error.title}</h4>
          <p>{load.error.detail}</p>
          {load.error.retry && <button type="button" onClick={() => setReloads((n) => n + 1)}>Try again</button>}
        </div>
      )}

      <p role="status" aria-live="polite" className="muted">
        {problem ? "" : load.kind === "loading" && !load.previous ? "Loading observations…"
          : shown ? (total === 0 ? "No observations match these filters." : `Rows ${first.toLocaleString("en-US")} to ${last.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`) : ""}
      </p>

      {shown && shown.rows.length > 0 && (
        <div className="table-wrap" aria-busy={load.kind === "loading"}>
          <table className="flow">
            <caption className="sr-only">Observations, {HEADERS[query.sort.column]} {query.sort.direction === "asc" ? "ascending" : "descending"}</caption>
            <thead>
              <tr>
                {SORT_COLUMNS.slice(0, 3).map((c) => (
                  <th key={c} scope="col" aria-sort={ariaSort(c)}>
                    <button type="button" className="sort" onClick={() => sortBy(c)}>
                      {HEADERS[c]} <span aria-hidden="true">{ariaSort(c) === "ascending" ? "▲" : ariaSort(c) === "descending" ? "▼" : "↕"}</span>
                    </button>
                  </th>
                ))}
                <th scope="col">Source</th>
                {SORT_COLUMNS.slice(3).map((c) => (
                  <th key={c} scope="col" aria-sort={ariaSort(c)}>
                    <button type="button" className="sort" onClick={() => sortBy(c)}>
                      {HEADERS[c]} <span aria-hidden="true">{ariaSort(c) === "ascending" ? "▲" : ariaSort(c) === "descending" ? "▼" : "↕"}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.rows.map((r) => (
                <tr key={r.id} className={r.status === "entered-in-error" ? "in-error" : undefined}>
                  <td>
                    {r.measured ? <time dateTime={r.measured}>{formatInstantUtc(r.measured)}</time> : "unknown time"}
                    {r.measuredEnd && <div className="muted small">to <time dateTime={r.measuredEnd}>{formatInstantUtc(r.measuredEnd)}</time></div>}
                  </td>
                  <th scope="row">{r.metric}</th>
                  <td>
                    {r.value === null ? <span className="muted">no value</span> : <><span className="num">{formatValue(r.value)}</span> <span className="unit">{r.unit}</span></>}
                    {r.unitMismatch && <div className="small"><span aria-hidden="true">⚠ </span>unit differs: {r.unitMismatch}</div>}
                  </td>
                  <td>{SOURCE_LABEL[r.source]}</td>
                  <td>
                    {r.status === "final" ? r.status : <strong><span aria-hidden="true">⚑ </span>{r.status}</strong>}
                  </td>
                  <td>{r.received ? <time dateTime={r.received}>{formatInstantUtc(r.received)}</time> : "unknown"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 && (
        <nav aria-label="Flowsheet pages" className="pager">
          <button type="button" disabled={query.page === 0} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))}>Previous</button>
          <span>Page {query.page + 1} of {pages.toLocaleString("en-US")}</span>
          <button type="button" disabled={query.page + 1 >= pages} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}>Next</button>
        </nav>
      )}
      <p className="muted small">Times are UTC. Status other than final is flagged, never hidden. Source can be filtered but not sorted (the server does not order it reliably).</p>
    </section>
  );
}
