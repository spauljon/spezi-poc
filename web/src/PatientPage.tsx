import { useCallback, useEffect, useState } from "react";
import { IntradayPage } from "./intraday/IntradayPage.tsx";
import { TrendsPage } from "./trends/TrendsPage.tsx";
import { flowsheetHref, parseHash, trendsHref } from "./route.ts";
import { useAuth } from "./auth/AuthProvider.tsx";
import { BannerPage } from "./banner/BannerPage.tsx";
import type { WebConfig } from "./config.ts";
import type { WebContract } from "./contract.ts";
import { explainError, type Explained } from "./explain.ts";
import { FhirClient } from "./fhir/client.ts";
import type { Patient } from "./fhir/types.ts";
import { Flowsheet } from "./flowsheet/Flowsheet.tsx";
import { loadPatient } from "./patient.ts";

type State =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly patient: Patient & { id: string } }
  | { readonly kind: "error"; readonly error: Explained };

/** Resolves the patient once, then shows the banner and the flowsheet for them. */
export function PatientPage({ config, contract }: { config: WebConfig; contract: WebContract }) {
  const auth = useAuth();
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    try {
      const client = new FhirClient(config.fhirBase, () => auth.accessToken());
      setState({ kind: "ready", patient: await loadPatient(client, config, contract) });
    } catch (error) {
      setState({ kind: "error", error: explainError(error) });
    }
  }, [auth, config, contract]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "loading") {
    return <p role="status" className="state">Loading patient…</p>;
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="state state-error">
        <h2>{state.error.title}</h2>
        <p>{state.error.detail}</p>
        {state.error.retry && <button type="button" onClick={() => void load()}>Try again</button>}
      </div>
    );
  }
  return (
    <>
      <BannerPage config={config} contract={contract} patient={state.patient} />
      <nav aria-label="Views" className="views">
        <a href={trendsHref()} aria-current={route.view === "flowsheet" ? undefined : "page"}>Trends</a>
        <a href={flowsheetHref} aria-current={route.view === "flowsheet" ? "page" : undefined}>Flowsheet</a>
      </nav>
      {route.view === "flowsheet" && <Flowsheet config={config} contract={contract} patientId={state.patient.id} />}
      {route.view === "trends" && <TrendsPage config={config} contract={contract} patientId={state.patient.id} initialRange={route.range} />}
      {route.view === "day" && (
        <IntradayPage config={config} contract={contract} patientId={state.patient.id} day={route.day} metric={route.metric} range={route.range} />
      )}
    </>
  );
}
