# Runbook: operating the POC stack

How to start, check, update, reset and tear down the stack, and what each common failure looks like. Written 2026-10-17 (M19); the commands were run on that day unless a line says otherwise. TLS and trust have their own runbook: [tls-and-trust.md](tls-and-trust.md).

## What is running

One compose project, `spezi-poc`, on this Mac. Always go through `make` or `scripts/compose.sh` (they pin the project name), never a bare `docker compose`: the governance project's stack must never be touched.

| Container | What it is | Reachable at |
|---|---|---|
| `spezi-poc-oracle` | Oracle Free: the HAPI, analytics and Keycloak databases (one volume, `spezi-poc_oracle_data`) | `127.0.0.1:1522` only |
| `spezi-poc-hapi` | HAPI FHIR R4 | `https://macpro16.local:8443/fhir`, token required (except `GET /metadata`) |
| `spezi-poc-keycloak`, `spezi-poc-idp-edge` | the IdP and the proxy in front of it | `https://macpro16.local:8444` (public OIDC paths only) |
| `spezi-poc-analytics-worker` | scans HAPI every 30 s, writes daily rollups | no port |
| `spezi-poc-analytics-api` | the analytic API | `127.0.0.1:8445`, TLS, clinician token |
| `spezi-poc-web` | the clinician web app (nginx) | `https://macpro16.local:3000` |

## Start, stop, check

```bash
make stack-up        # credentials, CA and certificates if missing, then every service; waits until all are healthy
make stack-ps        # what is running and its health
make stack-verify    # the infrastructure checks; a SKIP line means a check did NOT run
make stack-down      # stop everything, KEEP the data
```

A healthy stack shows every container `(healthy)`. `make stack-up` is safe to repeat. A first start takes several minutes (the database initialises itself) and pulls one image.

**Logs** are per container and are lost when a container is recreated:

```bash
docker logs --since 30m spezi-poc-analytics-worker    # one JSON line per scan: scanned, touched, recomputed, changed
docker logs --since 30m spezi-poc-hapi
```

The IdP proxy's log records the User-Agent, so a phone's request is recognisable.

## Update one service after a code change

`make stack-up` runs `up -d --build`, which rebuilds an image but **did not always replace the running container** (found 2026-10-17: the web image was rebuilt, the old container kept running). After changing analytics or web code:

```bash
scripts/compose.sh up -d --build --wait analytics-worker analytics-api web
docker inspect spezi-poc-web --format '{{.Image}}' | cut -c8-19    # the image the container runs
docker images -q spezi-poc-web:local                                 # the image just built: these must match
```

If they differ, force it (only that service, no dependencies):

```bash
scripts/compose.sh up -d --force-recreate --no-deps --wait web
```

**A database schema change** (the analytic store) is applied by the owner, idempotently, without a restart:

```bash
make analytics-migrate
```

## Failures and what they mean

| Symptom | Cause | What to do |
|---|---|---|
| Phone says "certificate invalid" | the phone does not trust **this** CA (a rebuild makes a new one) | [tls-and-trust.md](tls-and-trust.md), step 3 |
| Phone says "could not connect" | the Mac is asleep, Docker is stopped, or the phone is on another network | `make stack-ps`; keep the Mac awake for background tests (`caffeinate -dimsu`) |
| Nothing uploaded overnight | the stack was down: the phone **queues** and catches up when it is back (nothing is lost) | start the stack; open the app once; check the Sync section's attempt history |
| Web page: "Not permitted" | the signed-in user lacks `clinician-reader` | sign in as the clinician user; the UI check is display only, the API enforces |
| Web trends: "The analytic service's answer was not understood" | an API older or newer than the web build (for example after updating only one) | update both, as above |
| Worker log shows `fetch failed` | HAPI is down; the worker backs off (30 s then 60 s) and resumes by itself | start HAPI; no action on the worker |
| A nutrient's totals are missing for data that is in HAPI | the worker's watermark is past that data: it was written before the contract gave the worker the metric's code | `make analytics-rescan`; the running worker re-reads everything within one cycle (about 30 s). Check with `python3 analytics/verify-intake.py [poc-real]` |
| A new field is missing in the API | the container still runs the old image | the image-id check above |
| Port 3000 busy for `make web-dev` | the deployed `web` service owns it | `make stack-down` or use the deployed app |

## Tokens for hand checks

```bash
TOKEN=$(idp/capture-token.sh)
curl --cacert ~/.poc-ca/ca.crt -H "Authorization: Bearer $TOKEN" "https://macpro16.local:8443/fhir/Patient?_summary=count"
```

The script reads the password from the git-ignored `idp/.env.local`, never prints it, and prints only the token. `idp/.env.local` is edited by nothing but you: **a hand edit of one value (the capture user's password) once made every login fail** (2026-10-14); Keycloak keeps the password it was created with.

## Data: where it lives and how to remove it

- **Everything** (FHIR data, analytics rollups, Keycloak) is in the one Oracle volume. Since M17 that includes **real HealthKit data** under the `poc-real` Patient.
- `make stack-down` keeps it. To erase it:

```bash
make stack-reset     # removes the containers and, after you answer y, the volume
```

- After a reset the old passwords are gone with the volume: a new `.env.local` is made by `make stack-env`, and the phone app must be **deleted and reinstalled** (its queue and HealthKit bookmarks say everything was already sent, so against an empty server it would upload nothing).
- Nothing real is ever in the repository; `make guard-all` scans the working tree for the obvious patterns (a backstop, not proof).

## Live checks after a rebuild

The live suites need data the fresh stack lacks:

```bash
make web-seed-dense-day             # one dense synthetic day, idempotent
make web-seed-sleep-nights          # three known synthetic nights, idempotent
make test-ios-integration           # uploads through the app's real code path; needs the simulator booted and trusting the CA
make test-analytics-live
python3 analytics/verify-intake.py  # nutrition totals vs an independent sum from HAPI (add `poc-real` for your own data; counts only)
make test-web-live                  # two checks also need a long synthetic history (daily resting heart rate, more than five nights)
```

`make test-ios-integration` needs the CA in the simulator (`scripts/ios-sim-trust.sh install`, with the simulator **booted**; it says "No devices are booted" otherwise). The two history-dependent web checks fail on a fresh stack until the simulator has produced weeks of synthetic data: that is missing data, not a defect.
