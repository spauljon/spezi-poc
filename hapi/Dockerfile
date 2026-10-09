# HAPI FHIR 7.6.0 for the POC. Adapted from the governance project's hapi/Dockerfile
# (see hapi/README.md for provenance).
#
# The image entrypoint puts /app/extra-classes on -Dloader.path, so a jar placed there joins the
# application classpath additively (upstream classes win). The M4 extension jar (hapi/ext) verifies
# Keycloak tokens and applies role-based rules; it is thin: every dependency is 'provided' by main.war.

# Build stage: compiles the extension and RUNS ITS UNIT TESTS (a failing test fails the image build).
# Build-only image, pinned by digest (maven 3.9.9, Temurin 17, arm64); nothing from it ships.
FROM maven@sha256:f58d59b6273e785ac0a4477f6e9b5ba1d7731c75b906c0f7b34076f1851318cc AS build-ext
WORKDIR /build
COPY ext/pom.xml .
RUN mvn -B -ntp dependency:go-offline
COPY ext/src ./src
RUN mvn -B -ntp package

FROM busybox:1.37-musl AS busybox-install
RUN busybox --install /bin

FROM hapiproject/hapi:v7.6.0
# The upstream image is distroless; busybox provides wget for the container healthcheck.
COPY --from=busybox-install /bin /bin/
COPY --from=build-ext --chown=65532:65532 /build/target/hapi-ext.jar /app/extra-classes/
USER 65532:65532
