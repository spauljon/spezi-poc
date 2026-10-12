import { formatAge, formatInstantUtc, formatValue } from "../format.ts";
import type { BannerModel, SourceKind } from "./model.ts";

const SOURCE_LABEL: Record<SourceKind, string> = {
  synthetic: "Synthetic simulator",
  healthKit: "HealthKit",
  unknown: "Unknown source",
};

/** Staleness is stated in words and with a mark, never by colour alone. */
function Freshness({ model }: { model: BannerModel }) {
  const s = model.staleness;
  if (s.state === "none") {
    return (
      <p className="freshness freshness-none" role="status">
        <span aria-hidden="true">○ </span>
        <strong>No data received yet.</strong> Absence of data is not a normal reading.
      </p>
    );
  }
  const age = formatAge(s.ageMinutes);
  if (s.state === "stale") {
    return (
      <p className="freshness freshness-stale" role="alert">
        <span aria-hidden="true">⚠ </span>
        <strong>Stale: last data received {age} ago</strong> (limit {formatAge(s.thresholdMinutes)}). Values below may
        not reflect the patient now.
      </p>
    );
  }
  return (
    <p className="freshness freshness-current" role="status">
      <span aria-hidden="true">● </span>
      <strong>Current: last data received {age} ago</strong>
    </p>
  );
}

export function Banner({ model }: { model: BannerModel }) {
  return (
    <section aria-label="Patient banner" className="banner">
      <header className="banner-head">
        <h2>{model.patientName}</h2>
        {model.patientIdentifier && <p className="muted">Identifier {model.patientIdentifier}</p>}
      </header>

      <Freshness model={model} />
      {model.lastReceivedAt && (
        <p className="muted">
          Last received by the server: <time dateTime={model.lastReceivedAt}>{formatInstantUtc(model.lastReceivedAt)}</time>
          {model.timestampInFuture && " (ahead of this device's clock)"}
        </p>
      )}
      <p className="muted">
        Sources:{" "}
        {model.sources.length === 0 ? "none yet" : model.sources.map((k) => SOURCE_LABEL[k]).join(", ")}
      </p>

      <h3>Latest values</h3>
      <table className="values">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Value</th>
            <th scope="col">Measured</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {model.values.map((v) => (
            <tr key={v.metricId}>
              <th scope="row">{v.display}</th>
              <td>
                <span className="num">{formatValue(v.value)}</span> <span className="unit">{v.unit}</span>
              </td>
              <td><time dateTime={v.effective}>{formatInstantUtc(v.effective)}</time></td>
              <td>{SOURCE_LABEL[v.source]}</td>
            </tr>
          ))}
          {model.missing.map((m) => (
            <tr key={m.metricId} className="no-data">
              <th scope="row">{m.display}</th>
              <td colSpan={3}>No data</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Data and provenance only; not an interpretation. Times are UTC.</p>
    </section>
  );
}
