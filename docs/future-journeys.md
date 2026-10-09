# Future journeys (parking lot)

Ideas deliberately **not scheduled**. Nothing here is a commitment or part of the milestone plan. Each entry records the intent, what was learned when it was parked, and what would have to be decided first, so it can be picked up later without redoing the thinking.

---

## FJ-1: Local Kubernetes with mesh mTLS between pods, cleartext services inside

**Parked:** 2026-10-09. **Status:** not started; not scheduled; do after the main milestone plan (at least M1-M4) so there is a working system to migrate.

### Intent
Run the POC on a local Kubernetes cluster where a service mesh gives **mutual TLS between every pair of pods**, while the application containers themselves speak **cleartext** to their own proxy (the "recommended" shape for regulated data: encrypted in transit everywhere, simple apps, identity-based authorization). The point is to learn how that architecture is built, operated and verified. It is a learning goal, not a POC requirement.

### Where this came from
A question about whether enterprises run services in cleartext behind a TLS-terminating process. The researched answer (2026-10-09), with source quality noted:
- Edge termination with cleartext inside is common but is no longer the recommended posture for PHI; zero-trust guidance (NIST [SP 800-207](https://csrc.nist.gov/news/2020/zero-trust-architecture-nist-publishes-sp-800-207), 800-207A) says no implicit trust from network location.
- Mesh mTLS is the usual implementation. Istio **ambient mode** (per-node `ztunnel` for L4 mTLS, optional waypoint proxies for L7) is the newer design; see [Solo.io](https://www.solo.io/topics/istio/ambient-mode/) and [Cloud Native Now](https://cloudnativenow.com/contributed-content/how-istio-ambient-is-revolutionizing-cloud-connectivity/) (vendor-leaning). One practitioner view says ambient is not yet at parity with the sidecar model.
- HIPAA's proposed Security Rule overhaul would make encryption in transit required, but it is **not final** (agenda now shows July 2027): [Fierce Healthcare](https://www.fiercehealthcare.com/health-tech/feds-push-back-hipaa-security-rule-overhaul-july-2027), [Akerman](https://www.akerman.com/en/perspectives/hrx-new-year-new-hipaa-security-rule-requirements-ocr-proposes-sweeping-changes-for-hipaa-security-rule-to-bolster-cybersecurity.html).
- Related practice to fold in: short-lived automated certificates and name-constrained private CAs ([SPIFFE X.509-SVID](https://spiffe.io/docs/latest/spiffe-specs/x509-svid/), [name-constraints write-up](https://systemoverlord.com/2020/06/14/private-ca-with-x-509-name-constraints.html)); hybrid post-quantum key exchange arrives by default in JDK 27 ([JEP 527](https://openjdk.org/jeps/527)).
- Not verified against primary sources: the Istio ambient security documentation, NIST's exact mTLS wording, and the RFC 8705 certificate-bound-token details.

### Feasibility on this machine (checked 2026-10-09, nothing installed)
- Apple M2 Max, arm64, 12 cores, 64 GB RAM, 1.2 TB free disk. Plenty.
- **Docker Desktop's VM is allocated about 7.75 GiB of memory** (12 CPUs). That is the constraint: a cluster, a mesh, Oracle Free (its SGA+PGA alone is 2 GB), HAPI and Keycloak will need more. Raise it in Docker Desktop settings (you decide; 64 GB host RAM allows it).
- Already installed: `kubectl`, `helm`. Not installed: `kind`, `k3d`, `minikube`, `istioctl`, `linkerd`.
- Images must be arm64 (the Oracle Free image used here is; HAPI ran fine).

### Rough shape (a sketch, not a plan)
| Piece | Idea |
|---|---|
| Cluster | local, container-based (candidates: kind, k3d, minikube, or Docker Desktop's built-in Kubernetes; Colima/OrbStack are other runtimes) |
| Mesh | Istio ambient (mTLS by `ztunnel`) or Linkerd (mTLS on by default, simpler); a deliberate choice to make |
| Edge | an ingress/gateway terminates TLS for outside clients using our POC CA (so the iPhone trust path from M3/M4 still applies) |
| Apps | HAPI, Keycloak, analytics worker, clinician web as pods; HAPI would listen **cleartext** on its pod port (undo `server.ssl` from M2); the mesh encrypts pod-to-pod |
| Oracle | decision needed: in the cluster (StatefulSet) or outside it as an external service reached through the mesh |
| Authorization | mesh policy as a **second layer**: default-deny, allow only named service identities; JWT verification inside HAPI (M4) stays, since "inside the mesh" is not a reason to drop it |

### What would change in the existing repo
Cleartext HAPI behind an edge proxy; `compose.yaml` would sit alongside (or be replaced by) manifests/Helm; `db/verify.sh` TLS checks would move to the ingress; the "known cleartext hop" (HAPI to Oracle) in `hapi/README.md` would become encrypted; the CA could feed the mesh as an upstream (or the mesh issues short-lived workload certificates).

### Decisions to make when picked up
1. Which local cluster tool, and whether to use Docker Desktop's built-in Kubernetes.
2. Istio ambient vs. Linkerd vs. another mesh (and whether sidecar or sidecar-less).
3. Oracle in or out of the cluster.
4. Certificate authority: mesh-internal CA vs. cert-manager with our CA as upstream; add a critical name constraint to our CA.
5. How the iPhone reaches the cluster (a port published on the Mac, a load-balancer shim, etc.), keeping `macpro16.local` and the existing certificate story.
6. How to prove it: show ciphertext between pods (packet capture) while the app container sees plain HTTP on localhost; show a denied call from a workload without an allowed identity.
7. Memory budget (Docker Desktop VM size) and installs (each tool is an external install and needs explicit approval).

### Verification ideas
- A pod-to-pod request succeeds, and a capture on the node shows no readable HTTP.
- A request from a pod without an allowed identity is rejected by mesh policy before reaching HAPI.
- HAPI still rejects a missing or invalid JWT (defense in depth).
- The iPhone loads the endpoint through the edge without trust warnings.

### Not now because
The main plan (M1-M19) is still in progress, and this journey is only worth doing against a working system. Revisit after M4 (token verification) at the earliest.
