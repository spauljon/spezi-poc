import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider.tsx";
import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import { FhirClient, FhirError } from "../fhir/client.ts";
import { Banner } from "./Banner.tsx";
import { BannerLoadError, loadBanner } from "./load.ts";
import type { BannerModel } from "./model.ts";

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly model: BannerModel; readonly loadedAt: number }
  | { readonly kind: "error"; readonly title: string; readonly detail: string; readonly retry: boolean };

function explain(error: unknown): View {
  if (error instanceof BannerLoadError) {
    return {
      kind: "error",
      title: error.reason === "patientNotFound" ? "Patient not found" : "More than one patient matches",
      detail: error.message,
      retry: false,
    };
  }
  if (error instanceof FhirError) {
    switch (error.kind) {
      case "unauthorized":
        return { kind: "error", title: "Your sign-in was not accepted", detail: "Please sign in again.", retry: false };
      case "forbidden":
        return { kind: "error", title: "Not permitted", detail: "This account may not read patient data.", retry: false };
      case "network":
        return { kind: "error", title: "The server could not be reached", detail: "Check the connection and try again.", retry: true };
      default:
        return { kind: "error", title: "The server reported a problem", detail: error.message, retry: true };
    }
  }
  return { kind: "error", title: "Something went wrong", detail: "The banner could not be loaded.", retry: true };
}

/**
 * Loads the banner, refreshes it every minute, and re-evaluates staleness against the clock every 15 seconds so the
 * indicator appears by itself when data stops arriving.
 */
export function BannerPage({ config, contract, refreshMs = 60_000, clockMs = 15_000 }: {
  config: WebConfig;
  contract: WebContract;
  refreshMs?: number;
  clockMs?: number;
}) {
  const auth = useAuth();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const client = new FhirClient(config.fhirBase, () => auth.accessToken());
    try {
      const model = await loadBanner(client, config, contract, new Date());
      setView({ kind: "ready", model, loadedAt: Date.now() });
    } catch (error) {
      setView(explain(error));
    }
  }, [auth, config, contract]);

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
