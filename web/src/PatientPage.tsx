import { useCallback, useEffect, useState } from "react";
import { IntradayPage } from "./intraday/IntradayPage.tsx";
import { TrendsPage } from "./trends/TrendsPage.tsx";
import { NutritionPage } from "./nutrition/NutritionPage.tsx";
import { SleepPage } from "./sleep/SleepPage.tsx";
import { flowsheetHref, nutritionHref, parseHash, sleepHref, trendsHref } from "./route.ts";
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
  // In memory only: reloading the page always returns to the synthetic data set.
  const [dataSet, setDataSet] = useState<"synthetic" | "real">("synthetic");

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const client = new FhirClient(config.fhirBase, () => auth.accessToken());
      const identifier = dataSet === "real" ? config.healthKitPatientIdentifier : config.patientIdentifier;
      setState({ kind: "ready", patient: await loadPatient(client, { ...config, patientIdentifier: identifier }, contract) });
    } catch (error) {
      setState({ kind: "error", error: explainError(error) });
    }
  }, [auth, config, contract, dataSet]);

  useEffect(() => {
    void load();
  }, [load]);

  const switcher = (
    <div className="dataset" role="group" aria-label="Data set">
      <button type="button" aria-pressed={dataSet === "synthetic"} onClick={() => setDataSet("synthetic")}>Synthetic data</button>
      <button type="button" aria-pressed={dataSet === "real"} onClick={() => setDataSet("real")}>Real data (Apple Health)</button>
    </div>
  );
  if (state.kind === "loading") {
    return <><p role="status" className="state">Loading patient…</p></>;
  }
  if (state.kind === "error") {
    return (
      <>
        {switcher}
        <div role="alert" className="state state-error">
          <h2>{state.error.title}</h2>
          <p>
            {state.error.detail}
            {dataSet === "real" && " This is the separate patient for real Apple Health data; it exists only after the phone has uploaded."}
          </p>
          {state.error.retry && <button type="button" onClick={() => void load()}>Try again</button>}
        </div>
      </>
    );
  }
  return (
    <>
      {switcher}
      {dataSet === "real" && (
        <p className="real-data" role="note"><strong>Real data.</strong> This is a person&apos;s own Apple Health data, not synthetic.</p>
      )}
      <BannerPage config={config} contract={contract} patient={state.patient} />
      <nav aria-label="Views" className="views">
        <a href={trendsHref()} aria-current={route.view === "trends" || route.view === "day" ? "page" : undefined}>Trends</a>
        <a href={sleepHref()} aria-current={route.view === "sleep" ? "page" : undefined}>Sleep</a>
        <a href={nutritionHref()} aria-current={route.view === "nutrition" ? "page" : undefined}>Nutrition</a>
        <a href={flowsheetHref} aria-current={route.view === "flowsheet" ? "page" : undefined}>Flowsheet</a>
      </nav>
      {route.view === "flowsheet" && <Flowsheet config={config} contract={contract} patientId={state.patient.id} />}
      {route.view === "sleep" && (
        <SleepPage config={config} contract={contract} patientId={state.patient.id} night={route.night} start={route.start} />
      )}
      {route.view === "nutrition" && (
        <NutritionPage config={config} contract={contract} patientId={state.patient.id} nutrient={route.nutrient} />
      )}
      {route.view === "trends" && <TrendsPage config={config} contract={contract} patientId={state.patient.id} initialRange={route.range} />}
      {route.view === "day" && (
        <IntradayPage config={config} contract={contract} patientId={state.patient.id} day={route.day} metric={route.metric} range={route.range} />
      )}
    </>
  );
}
