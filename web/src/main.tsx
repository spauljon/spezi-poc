import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { AuthProvider } from "./auth/AuthProvider.tsx";
import { OidcAuthClient } from "./auth/client.ts";
import { loadConfig } from "./config.ts";
import { contract } from "./contract.ts";
import "./styles.css";

const config = loadConfig(import.meta.env, window.location);
const client = new OidcAuthClient(config);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <AuthProvider client={client}>
      <App config={config} contract={contract} />
    </AuthProvider>
  </StrictMode>,
);
