import { useAuth } from "./auth/AuthProvider.tsx";
import { PatientPage } from "./PatientPage.tsx";
import type { WebConfig } from "./config.ts";
import type { WebContract } from "./contract.ts";

export function App({ config, contract }: { config: WebConfig; contract: WebContract }) {
  const auth = useAuth();
  const { state } = auth;
  return (
    <div className="shell">
      <header className="topbar">
        <h1>Clinician view <span className="badge">POC · synthetic data</span></h1>
        {state.status === "signedIn" && (
          <div className="who">
            <span>{state.user.username ?? "Signed in"}</span>
            <button type="button" onClick={auth.signOut}>Sign out</button>
          </div>
        )}
      </header>
      <main>
        {state.status === "loading" && <p role="status" className="state">Checking sign-in…</p>}
        {state.status === "signedOut" && (
          <div className="state">
            <h2>Sign in</h2>
            <p>Sign in with your clinician account to view the patient.</p>
            <button type="button" onClick={auth.signIn}>Sign in</button>
          </div>
        )}
        {state.status === "error" && (
          <div role="alert" className="state state-error">
            <h2>Sign-in problem</h2>
            <p>{state.message}</p>
            <button type="button" onClick={auth.signIn}>Sign in</button>
          </div>
        )}
        {state.status === "signedIn" && !state.user.roles.includes("clinician-reader") && (
          <div role="alert" className="state state-error">
            <h2>Not permitted</h2>
            <p>This account does not have the clinician role.</p>
          </div>
        )}
        {state.status === "signedIn" && state.user.roles.includes("clinician-reader") && (
          <PatientPage config={config} contract={contract} />
        )}
      </main>
      <footer className="muted small">
        This is not a medical device. It shows data and where it came from, not diagnoses.
      </footer>
    </div>
  );
}
