import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.tsx";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { AppUser, AuthClient } from "../src/auth/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { NOW, bundle, config, contract, fakeHapi, json, obs, patient } from "./support.ts";

const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN).toISOString();

const clinician: AppUser = { username: "clinician-user", roles: ["clinician-reader"], expiresAt: Date.now() + 600_000 };

function fakeClient(over: Partial<AuthClient> = {}): AuthClient & { signIn: ReturnType<typeof vi.fn>; completeSignIn: ReturnType<typeof vi.fn> } {
  return {
    getUser: vi.fn(async () => null),
    signIn: vi.fn(async () => undefined),
    completeSignIn: vi.fn(async () => clinician),
    accessToken: vi.fn(async () => "tok"),
    signOut: vi.fn(async () => undefined),
    onSignedOut: vi.fn(() => () => undefined),
    ...over,
  } as never;
}

function renderApp(client: AuthClient, path = "/") {
  const history = { replaceState: vi.fn() };
  const view = render(
    <AuthProvider client={client} location={{ pathname: path, href: `https://web.test:3000${path}?code=x&state=y`, origin: "https://web.test:3000" }} history={history}>
      <App config={config} contract={contract} />
    </AuthProvider>,
  );
  return { ...view, history };
}

const hapi = (observations: Observation[], opts: { patients?: unknown[]; status?: number } = {}) =>
  fakeHapi(observations, opts);

beforeEach(() => {
  vi.stubGlobal("fetch", hapi([]));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("signed out", () => {
  it("offers sign in and does not redirect by itself", async () => {
    const client = fakeClient();
    renderApp(client);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(client.signIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(client.signIn).toHaveBeenCalledTimes(1);
  });

  it("completes the redirect once, cleans the address bar, then shows the banner", async () => {
    vi.stubGlobal("fetch", hapi([obs("heartRate", 72, ago(5), ago(4))]));
    const client = fakeClient();
    const { history } = renderApp(client, "/callback");
    expect(await screen.findByText("Poc Synthetic")).toBeTruthy();
    expect(client.completeSignIn).toHaveBeenCalledTimes(1);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("a failed callback shows a sign-in problem, with a way to retry", async () => {
    const client = fakeClient({ completeSignIn: vi.fn(async () => { throw new Error("bad state"); }) });
    renderApp(client, "/callback");
    expect(await screen.findByText("Sign-in problem")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("an account without the clinician role is told so and no data is requested", async () => {
    const fetchSpy = hapi([]);
    vi.stubGlobal("fetch", fetchSpy);
    renderApp(fakeClient({ getUser: vi.fn(async () => ({ ...clinician, roles: ["capture-writer"] })) }));
    expect(await screen.findByText("Not permitted")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("banner states", () => {
  const signedIn = () => fakeClient({ getUser: vi.fn(async () => clinician) });

  it("current data: values with units, 'Current', source and UTC times", async () => {
    vi.stubGlobal("fetch", hapi([
      obs("heartRate", 72, ago(5), ago(4)),
      obs("hrvSdnn", 41.24, ago(10), ago(9)),
    ]));
    renderApp(signedIn());
    expect(await screen.findByText(/Current: last data received/)).toBeTruthy();
    expect(screen.getByText("72")).toBeTruthy();
    expect(screen.getAllByText(/UTC/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Synthetic simulator").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stale data: an alert in words, and the values are still shown (not hidden)", async () => {
    vi.stubGlobal("fetch", hapi([obs("heartRate", 72, ago(300), ago(299))]));
    renderApp(signedIn());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Stale: last data received 4 h 59 min ago/);
    expect(screen.getByText("72")).toBeTruthy();
  });

  it("staleness appears by itself as the clock advances, with no new request", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      vi.setSystemTime(NOW);
      const fetchSpy = hapi([obs("heartRate", 72, new Date(NOW.getTime() - 5 * MIN).toISOString(), new Date(NOW.getTime() - 5 * MIN).toISOString())]);
      vi.stubGlobal("fetch", fetchSpy);
      render(
        <AuthProvider client={signedIn()} location={{ pathname: "/", href: "https://web.test:3000/", origin: "https://web.test:3000" }} history={{ replaceState: vi.fn() }}>
          <App config={config} contract={contract} />
        </AuthProvider>,
      );
      await waitFor(() => expect(screen.getByText(/Current: last data received/)).toBeTruthy());
      const calls = fetchSpy.mock.calls.length;
      await act(async () => { vi.setSystemTime(new Date(NOW.getTime() + 40 * MIN)); await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByText(/Stale: last data received/)).toBeTruthy();
      expect(fetchSpy.mock.calls.length).toBe(calls); // re-evaluated locally, within the 60 s refresh
    } finally {
      vi.useRealTimers();
    }
  });

  it("a patient with nothing received yet is 'No data received', and each metric says 'No data'", async () => {
    renderApp(signedIn());
    expect(await screen.findByText(/No data received yet/)).toBeTruthy();
    expect(screen.getAllByText("No data")).toHaveLength(contract.quantityMetrics.length);
  });

  it("patient not found has its own state", async () => {
    vi.stubGlobal("fetch", hapi([], { patients: [] }));
    renderApp(signedIn());
    expect(await screen.findByText("Patient not found")).toBeTruthy();
  });

  it("an unreachable server offers a retry, and retry loads", async () => {
    let fail = true;
    const fake = fakeHapi([obs("heartRate", 72, ago(5), ago(4))], { failNetwork: () => fail });
    vi.stubGlobal("fetch", fake);
    renderApp(signedIn());
    expect(await screen.findByText("The server could not be reached")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Current: last data received/)).toBeTruthy();
  });

  it.each([[401, "Your sign-in was not accepted"], [403, "Not permitted"]] as const)(
    "HTTP %i from the server is explained, not shown as a crash", async (status, title) => {
      vi.stubGlobal("fetch", hapi([], { status }));
      renderApp(signedIn());
      expect(await screen.findByText(title)).toBeTruthy();
    });

  it("sign out returns to the signed-out view", async () => {
    vi.stubGlobal("fetch", hapi([obs("heartRate", 72, ago(5), ago(4))]));
    renderApp(signedIn());
    await screen.findByText(/Current: last data received/);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});
