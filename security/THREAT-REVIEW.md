# Fleet contract threat review

Scope: the attached Fleet v1 contract, parent amendments for module paths, Vehicle.source, Ping.telemetry_time and feed registration, and this lane's implementation. This is a design review, not an audit of a deployed service. Items below distinguish local controls from required integration and unresolved decisions.

## Location and patient privacy

Precise live vehicle history and destination labels can reveal sensitive movement even with no patient fields. Never put patient identifiers or clinical notes in callsign/destination/message fields. Local validators reject unknown fields and control characters but cannot recognize patient identity in allowed free text. UI must render labels as text, not HTML. Do not include live data in public demo/stand-in snapshots or shared analytics. Public-feed stand-ins must remain labelled as buses/public-feed vehicles, never ambulances; `source` must be set by authorized server registration, not a public client.

Required integration: private authenticated fleet access, no-store response headers, redacted operational logs, no caching live payloads at edge, no live data in public snapshots, separate demo storage. Consider short-lived browser memory-only credentials and no localStorage tokens. Map tile providers receive viewer information and visible tile selection: no patient data may go into URLs. A restrictive CSP and careful map dependency handling need UI/deployment review.

Unresolved before real fleet operation: history retention/deletion period; who may see every vehicle; access revocation; operational access audit with no raw location/token dumps; privacy/legal review for the intended location and operator. The contract's "immutable history" cannot mean unlimited retention. Minimize alerts and free-text labels.

## Replay and telemetry integrity

An attacker holding a valid crew token may submit false coordinates for that vehicle until token expiry. HS256 protects token integrity, not device truth. Fleet-local event_id dedup plus recorded_at ordering prevents replay from creating duplicate history or moving the latest point backward only when storage performs it atomically. Replaying an event with a new UUID is not stopped by JWT or UUID validation. A dedup collision with different payload must not overwrite immutable history. Time validation bounds acceptable device time but does not prove it genuine. Receipt-only bridge records must carry telemetry_time=receipt rather than implying a device timestamp.

Local controls: signature verify via WebCrypto HMAC, pinned HS256, issuer/audience checks, integer exp/iat, maximum one-hour TTL, no future iat, optional nbf checks, role and vehicle guards, token length cap, bounded payload helpers. Expiry at the current second is rejected.

Required integration: Lane E ping validation; fleet-local event_id uniqueness and immutable inserts; atomic replay response/latest update; domain checks for timestamp bounds; Kafka topic/partition/offset-derived IDs and commit after API accept. Rate limiting reduces frequency, not spoofing. No clinical safety decisions may rely on these signals.

## Tenant isolation and roles

Never derive a fleet authority from request parameters. JWT fleet_id chooses the DO, and any claims crossing an internal boundary must come from the verified entry handler, not serialized client claims. Do not expose a direct public path to the DO bypassing Worker authorization. Guards must run on every method, including unknown paths, fallback handlers, history and WebSocket upgrade. A dispatcher token is not allowed to post pings; a crew token is not allowed to read fleet snapshots or register vehicles. Bridge may read fleet and write existing vehicles; amended contract permits stand_in registration only. Authorizing bridge registration still requires trusted operator-controlled issuance of bridge tokens.

Local controls: reserved demo fleet IDs rejected, requireFleet exact match, role guards, crew vehicle binding, stand_in-only bridge registration helper. Not verified here: runtime route wiring, DO isolation, SQL parameterization or storage schema. Integration tests must attempt cross-fleet IDs, role misuse and demo/live crossover.

## Credentials and WebSockets

Never ship real JWT_SECRET, generated tokens or Kafka credentials in source, static assets, artifact archives or frontend env. Minimum secret length is not proof of randomness. Same secret across fleets means issuer compromise affects all fleets: the operator must tightly control token minting. HS256 means the verifier can also mint; keep all secret-bearing code server-side. Rotation currently invalidates all tokens, with no kid negotiation or token revocation list.

Subprotocol transport avoids query-string token exposure but is still a credential-bearing header. Redact Authorization and Sec-WebSocket-Protocol from logs/error capture; never echo the token subprotocol. Bound long-lived WS connections to verified exp and close when expired. Same-origin Origin enforcement blocks cross-site browser upgrades; no CORS wildcard for live routes. The helper permits no-Origin HTTP service clients, which still require bearer auth; browser WebSockets with missing Origin are rejected.

Unresolved: token issuance workflow, authorized operator identities, secret rotation/runbook, per-device credential replacement and emergency revocation. No public login/self-register endpoint is added by this lane.

## Abuse and resource exhaustion

Streaming JSON reader caps real bytes regardless of false Content-Length, disallows compressed bodies, and parses fatal UTF-8. Route validators reject unknown fields and derived offline mutations. JWT is length-bounded before decoding. RateLimiter has bounded state, fails closed if new keys exhaust the table and avoids evicting depleted keys to bypass limits. Clock rollback does not double-credit refill.

Limits must be placed where they are effective: post-auth per-principal buckets in long-lived fleet DOs, plus an edge unauthenticated/public demo policy. In-memory buckets reset on DO eviction and are not a durable global quota. An unbounded number of DO fleets or WS sockets can still exhaust resources. Add per-fleet connection limits, output buffering caps, maximum concurrent writes and alarm backpressure. Apply limits to duplicates too. Configure platform rate controls before enabling live production. Returning 429 from the helper uses the contract error envelope; a handler may add Retry-After from consume().

## Priority before live enabling

Blocking integration checks: tenant routing and route guards; crew binding; no public reset/write/history/ack; public/live data separation; short-lived WS closure and no token echo; production secret provisioning; persisted ping dedup/order semantics; no-store all API responses.

Operational decisions still needed: privacy retention and access policy; issuance/revocation/rotation workflow; abuse limits under measured load; audit logging scope. This lane's passing unit tests do not settle these decisions or verify another lane's code.

## Further hardening from independent QA

Per-role keys are an optional future design: distinct dispatcher, crew and bridge secrets reduce cross-role compromise. This implementation deliberately uses the contracted JWT_SECRET only. If per-role keys are added, verify against an operator-controlled role/key mapping and enforce the verified role against the selected key; never select arbitrary secrets/URLs from an untrusted JWT header or payload. Do not silently reuse a missing role key as another role's key.

Crew tokens now have a 15-minute hard cap and 5-minute default, reducing stolen-token exposure. A revocation epoch stored for each principal/device can invalidate tokens issued earlier than that epoch; implementing it needs a source of truth consulted at authorization and socket broadcasts. Claims currently exposes exp, not iat, so revocation requires an explicit future interface/storage change rather than trusting client-supplied metadata. Rotation and a per-principal revocation epoch are different controls.

Audit dispatcher history access with principal, fleet, vehicle, action, time, result and bounded request correlation ID. Do not include full history, patient labels or tokens in the audit event. Protect audit logs with independent retention/access controls. This recommendation does not mean audit wiring exists here.

Explicitly redact Sec-WebSocket-Protocol along with Authorization throughout edge, application, trace and error systems. Configure CSP connect-src to same-origin HTTPS/WSS (and only necessary approved public-feed endpoints); do not add a wildcard to accommodate demo sockets. Frontend dependencies and map tile img-src policy need separate review.

Configure an edge per-IP rate limit on unauthenticated auth floods and public demo HTTP/WS traffic, using the platform's trusted client identity. Per-principal DO buckets do not help signature-verification floods before authentication. Do not use caller-controlled X-Forwarded-For as authoritative identity.

Identifiers are case-sensitive here: fleet-1 differs from Fleet-1, and v1 differs from V1. Preserve exact case in Durable Object names, SQL identity comparisons and dedup scopes. Do not lower-case routing while keeping exact-case auth guards. The reserved demo name is rejected case-insensitively in verified claims to avoid ambiguity. If storage ever changes normalization rules, migrate identifiers and auth comparisons together.

The closeWebSocketAtExpiry helper supplies a tested per-connection timeout fallback because local DO alarm wake behavior was reported unreliable by integration. Actual platform timer execution is still unverified by this lane. Persist exp and reject sends at/after exp, cap connections, retain cleanup, and avoid interpreting a successful helper unit test as a live socket expiry test.
