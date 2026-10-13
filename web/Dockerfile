# The clinician web app, deployed (M13a): `vite build` output served by nginx over TLS. The Vite dev server is for
# development only (`make web-dev`). Build context is the REPOSITORY ROOT (see the allowlist in .dockerignore).
FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
COPY contract/metrics.json /app/contract/metrics.json
RUN npx vite build

# The same pinned nginx image the IdP proxy uses (already local; nothing new is pulled for the runtime stage).
FROM nginx@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
COPY web/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
