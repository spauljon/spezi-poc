import type { WebContract } from "../contract.ts";
import { trendsHref } from "../route.ts";

/** Where a day's "Intraday" link lands until the dense view exists (M15): a stated placeholder, not a dead link. */
export function IntradayStub({ day, metric, contract }: { day: string; metric: string | null; contract: WebContract }) {
  const name = contract.quantityMetrics.find((m) => m.id === metric)?.display ?? "this metric";
  return (
    <section className="state" aria-labelledby="intraday-h">
      <h2 id="intraday-h">Intraday view: {day}</h2>
      <p>The intraday view for {name} on {day} (UTC) arrives in a later milestone (M15). Nothing is shown here yet.</p>
      <p><a href={trendsHref}>Back to trends</a></p>
    </section>
  );
}
