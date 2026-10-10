# Keycloak 26.8.0 + the Oracle JDBC driver, for the POC (M3c).
#
# Keycloak does not bundle the Oracle driver (docs: https://www.keycloak.org/server/db). The two jars below are
# the versions that guide names (23.26.2.0.0), fetched from Maven Central at build time and verified against
# SHA-256 checksums published there (ADD --checksum fails the build on a mismatch). Licence: Oracle Free Use
# Terms and Conditions. Nothing from this build stage ships except /opt/keycloak.
#
# Build-time options (db=oracle, health) are baked in by `kc.sh build`; runtime options stay in compose.yaml.

FROM quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc AS builder

ADD --checksum=sha256:96010f27fce64c285f9d1aab8f96357b8e00c49c9ad041ecf140c9d7d27eb3fb --chmod=644 \
    https://repo1.maven.org/maven2/com/oracle/database/jdbc/ojdbc17/23.26.2.0.0/ojdbc17-23.26.2.0.0.jar \
    /opt/keycloak/providers/ojdbc17.jar
ADD --checksum=sha256:d0ed0aadf7e319ee8f313a85436919eb75f1012cc20f97d384e72adfbecfe3bd --chmod=644 \
    https://repo1.maven.org/maven2/com/oracle/database/nls/orai18n/23.26.2.0.0/orai18n-23.26.2.0.0.jar \
    /opt/keycloak/providers/orai18n.jar

ENV KC_DB=oracle \
    KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc
COPY --from=builder /opt/keycloak/ /opt/keycloak/
