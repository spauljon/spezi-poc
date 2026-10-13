import { useCallback, useEffect, useState } from "react";
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
      <Flowsheet config={config} contract={contract} patientId={state.patient.id} />
    </>
  );
}
