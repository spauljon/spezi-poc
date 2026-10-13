# The analytics image: the worker (`loop`) and the analytic API (`api`) are one codebase and share it (M13a).
# Build context is the REPOSITORY ROOT (`.dockerignore` there is an allowlist): the app reads contract/metrics.json.
# Base: Node 24 (the major pinned in .nvmrc), by digest, so the build is reproducible. Dependencies are the
# exactly-pinned set from package-lock.json (`npm ci`); no credential, key or .env file is ever copied in.
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20

WORKDIR /app/analytics

COPY analytics/package.json analytics/package-lock.json analytics/.npmrc ./
# tsx (a dev dependency) runs the TypeScript sources directly, so dev dependencies are installed on purpose.
RUN npm ci --include=dev --no-audit --no-fund
ENV NODE_ENV=production

COPY analytics/tsconfig.json analytics/healthcheck.mjs ./
COPY analytics/src ./src
COPY contract/metrics.json /app/contract/metrics.json

# Compose runs the container as the host user's uid (so the 0600 TLS key on a bind mount is readable); the files
# above are world-readable and nothing is written inside the image except /tmp (a tmpfs at run time).
USER node
CMD ["node", "--import", "tsx", "src/main.ts", "loop"]
