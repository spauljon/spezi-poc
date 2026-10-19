import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { AppUser, AuthClient } from "../src/auth/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { Flowsheet } from "../src/flowsheet/Flowsheet.tsx";
import { TrendsPage } from "../src/trends/TrendsPage.tsx";
import { audit } from "./a11y-audit.ts";
import { FakeUPlot } from "./uplot-fake.ts";
import { NOW, config, contract, fakeHapi, obs, type BandRow } from "./support.ts";

const user: AppUser = { username: "clinician-user", roles: ["clinician-reader"], expiresAt: Date.now() + 600_000 };
const client = (): AuthClient => ({
  getUser: async () => user, signIn: async () => undefined, completeSignIn: async () => user,
  accessToken: async () => "tok", signOut: async () => undefined, onSignedOut: () => () => undefined,
});
const location = { pathname: "/", href: "https://web.test:3000/", origin: "https://web.test:3000" };

beforeEach(() => FakeUPlot.reset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** What the audit is able to see: each defect, and then the same markup repaired (the control). */
describe("the audit can see what it claims to", () => {
  const run = (html: string) => {
    document.body.innerHTML = html;
    return audit(document.body).map((p) => p.rule);
  };

  it.each([
    ["a button with no name", "<button></button>", "<button>Save</button>", "a control has no accessible name"],
    ["an icon-only link", "<a href='#x'><span aria-hidden='true'>x</span></a>", "<a href='#x' aria-label='Close'><span aria-hidden='true'>x</span></a>", "a control has no accessible name"],
    ["an input without a label", "<input type='text'>", "<label for='a'>Name</label><input id='a' type='text'>", "a control has no accessible name"],
    ["a table with no caption", "<table><tr><th scope='col'>a</th></tr></table>", "<table><caption>c</caption><tr><th scope='col'>a</th></tr></table>", "a table has no caption or name"],
    ["a header cell with no scope", "<table><caption>c</caption><tr><th>a</th></tr></table>", "<table><caption>c</caption><tr><th scope='col'>a</th></tr></table>", "a header cell has no scope"],
    ["a skipped heading level", "<h2>a</h2><h4>b</h4>", "<h2>a</h2><h3>b</h3>", "a heading jumps from h2 to h4"],
    ["a duplicate id", "<p id='x'>a</p><p id='x'>b</p>", "<p id='x'>a</p><p id='y'>b</p>", "an id is used more than once"],
    ["a focusable thing inside aria-hidden", "<div aria-hidden='true'><button>go</button></div>", "<div aria-hidden='true'><span>go</span></div>", "a focusable element sits inside aria-hidden"],
    ["a tab-focusable chart with no name", "<div tabindex='0' role='group'></div>", "<div tabindex='0' role='group' aria-label='Heart rate chart'></div>", "a tab-focusable element has no accessible name"],
    ["an image with no alt", "<img src='x.png'>", "<img src='x.png' alt=''>", "an image has no alt attribute"],
  ])("%s", (_name, bad, good, rule) => {
    expect(run(bad)).toContain(rule);
    expect(run(good)).not.toContain(rule);
  });
});

describe("pages that can be mounted without the stack", () => {
  it("trends, with flagged days and gaps, has no audit findings", async () => {
    const iso = (n: number) => new Date(Date.UTC(2026, 9, 12) + n * 86_400_000).toISOString().slice(0, 10);
    const rows = (metric: string): BandRow[] => Array.from({ length: 8 }, (_, i) => -i).filter((n) => n !== -3)
      .map((n) => ({ day: iso(n), n: metric === "restingHeartRate" ? 1 : 1000, min: 50, median: 62, max: metric === "restingHeartRate" ? 62 : 110, artifactSuspected: n === -1 ? 1 : 0, lateArrival: n === -2 ? 1 : 0 }));
    vi.stubGlobal("fetch", fakeHapi([], { analytics: { heartRate: rows("heartRate"), hrvSdnn: rows("hrvSdnn"), restingHeartRate: rows("restingHeartRate") } }));
    const { container } = render(
      <AuthProvider client={client()} location={location} history={{ replaceState: vi.fn() }}>
        <TrendsPage config={config} contract={contract} patientId="42" now={() => NOW} />
      </AuthProvider>,
    );
    await waitFor(() => expect(container.querySelectorAll("section.trend-card").length, container.textContent ?? "").toBe(contract.quantityMetrics.length));
    await waitFor(() => expect(container.querySelector(".trend-flags")).not.toBeNull());
    expect(audit(container)).toEqual([]);
  });

  it("the flowsheet, with flags, retracted rows and paging, has no audit findings", async () => {
    const f = contract.dataQualityFlag;
    const t = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
    const rows: Observation[] = Array.from({ length: 30 }, (_, i) => {
      const o = obs("heartRate", 60 + (i % 20), t(i), t(i));
      o.id = `r-${i}`;
      if (i % 7 === 0) o.meta = { ...o.meta, tag: [{ system: f.system, code: f.artifactSuspected }] };
      if (i % 11 === 0) o.status = "entered-in-error";
      return o;
    });
    vi.stubGlobal("fetch", fakeHapi(rows));
    const { container } = render(
      <AuthProvider client={client()} location={location} history={{ replaceState: vi.fn() }}>
        <Flowsheet config={config} contract={contract} patientId="42" />
      </AuthProvider>,
    );
    await screen.findByText(/Rows 1 to 25 of 30/);
    expect(audit(container)).toEqual([]);
  });
});
