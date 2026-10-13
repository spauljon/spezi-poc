import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import { FhirClient } from "../fhir/client.ts";
import { explainError } from "../explain.ts";
import type { Patient } from "../fhir/types.ts";
import { Banner } from "./Banner.tsx";
import { loadBanner } from "./load.ts";
import type { BannerModel } from "./model.ts";

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly model: BannerModel; readonly loadedAt: number }
  | { readonly kind: "error"; readonly title: string; readonly detail: string; readonly retry: boolean };

/**
 * Loads the banner, refreshes it every minute, and re-evaluates staleness against the clock every 15 seconds so the
 * indicator appears by itself when data stops arriving.
 */
export function BannerPage({ config, contract, patient, refreshMs = 60_000, clockMs = 15_000 }: {
  config: WebConfig;
  contract: WebContract;
  patient: Patient & { id: string };
  refreshMs?: number;
  clockMs?: number;
}) {
  const auth = useAuth();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const client = new FhirClient(config.fhirBase, () => auth.accessToken());
    try {
      const model = await loadBanner(client, config, contract, new Date(), patient);
      setView({ kind: "ready", model, loadedAt: Date.now() });
    } catch (error) {
      setView({ kind: "error", ...explainError(error) });
    }
  }, [auth, config, contract, patient]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => clearInterval(timer);
  }, [load, refreshMs]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), clockMs);
    return () => clearInterval(timer);
  }, [clockMs]);

  if (view.kind === "loading") {
    return <p role="status" className="state">Loading patient…</p>;
  }
  if (view.kind === "error") {
    return (
      <div role="alert" className="state state-error">
        <h2>{view.title}</h2>
        <p>{view.detail}</p>
        {view.retry && <button type="button" onClick={() => void load()}>Try again</button>}
      </div>
    );
  }
  return <Banner model={reevaluate(view.model, now, config.staleAfterMinutes)} />;
}

/** Recomputes the age at `now` from the stored newest timestamp, without another request. */
export function reevaluate(model: BannerModel, nowMs: number, thresholdMinutes: number): BannerModel {
  if (model.lastReceivedAt === null) {
    return model;
  }
  const raw = (nowMs - Date.parse(model.lastReceivedAt)) / 60_000;
  const ageMinutes = Math.max(0, raw);
  return {
    ...model,
    timestampInFuture: raw < 0,
    staleness: ageMinutes > thresholdMinutes
      ? { state: "stale", ageMinutes, thresholdMinutes }
      : { state: "current", ageMinutes, thresholdMinutes },
  };
}
