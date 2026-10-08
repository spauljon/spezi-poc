# HAPI FHIR 7.6.0 for the POC. Adapted from the governance project's hapi/Dockerfile
# (see hapi/README.md for provenance).
#
# The image entrypoint puts /app/extra-classes on -Dloader.path, so a jar placed there joins the
# application classpath additively (upstream classes win). M4 will add a thin extension jar for
# token verification and authorization; until then this image is stock HAPI plus a shell utility.

FROM busybox:1.37-musl AS busybox-install
RUN busybox --install /bin

FROM hapiproject/hapi:v7.6.0
# The upstream image is distroless; busybox provides wget for the container healthcheck.
COPY --from=busybox-install /bin /bin/
USER 65532:65532
