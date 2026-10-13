# Lane D: auth and security

Original implementation.

## Run

Requires Node 22+ and TypeScript compiler on PATH. No runtime dependencies, tokens, or real credentials are included.

```sh
cd <extracted module root>
tsc -p security/tsconfig.json
node --test security/test.mjs
```

The emitted `.security-build/` directory is local test output, not part of the delivered archive. The tests use Node's WebCrypto/Fetch and built-in test runner. They do not require Vitest. Integrators can run these commands alongside the project test suite.

## Public interface

Import from `worker/src/auth/index.ts`:

- `authorize(request, env): Promise<Claims>`; verified claims include `exp` in epoch seconds for WebSocket expiry checks.
- `ApiError(status, code, message)`, `AuthEnv`, `Claims`, `Role`.
- `issueToken(claimsWithoutExp, secret, {nowMs?, ttlSeconds?})`; default 300 seconds, crew maximum 900 seconds; dispatcher/bridge maximum 3600 seconds. Operator-only helper, never expose as a public endpoint. No production CLI/endpoint was created.
- `verifyToken(token, secret, nowMs?)`, `extractToken(request)`.
- `requireRole`, `requireFleet`, `requireVehicleAccess`, `requireRegistrationAccess`.
- `assertSameOrigin`, `readJson` (default body cap 16 KiB), `apiErrorResponse`.
- `validateVehicleRegistration`, `validateVehiclePatch`, `validateHistoryLimit`, `validateIdentifier`, `validateText`, `validateFinite`, `assertRecord`, `rejectUnknownKeys`.
- `RateLimiter`, `principalRateKey`.

`Claims.exp` is output metadata; token minting accepts claims without exp and sets it itself. `JWT_SECRET` must have at least 32 UTF-8 bytes; this is a length check, not an entropy check. Use an operator-generated random secret stored with the deployment's secret mechanism, never in source, fixtures, command history, or generated artifact files. The string in the tests is clearly a test-only key and is not configured for deployment.

## Required integration in Lane A

1. Authorize every live request before DO lookup. Use only `claims.fleet_id` as fleet routing input. Never accept fleet authority from a URL/body/header or expose `demo` through live auth.
2. Apply route role guards: fleet snapshot dispatcher/bridge, live events dispatcher only, ping crew/bridge, history/patch/ack dispatcher. Create allows dispatcher, or bridge with source `stand_in` only under the amended contract. Bridge identity provisioning must be operator-controlled; this module cannot infer whether a bridge is a feed adapter from its role alone.
3. For pings call `requireVehicleAccess(claims, ping.vehicle_id)`; still check vehicle existence in the correct fleet. Use Lane E's full `validatePing`; this module does not duplicate its telemetry rules.
4. Apply `assertSameOrigin` before browser writes and WS accept. HTTP requests without Origin are permitted for service clients. WebSockets require an Origin matching request URL origin. If nonbrowser WS clients are required, decide an explicit authenticated exception rather than disabling the browser check.
5. Use `readJson` before route schema validators; reject extra keys. Destination labels cannot be automatically proven free of patient data: operator policy and UI warnings outside this module remain necessary.
6. Keep limiter instances on the fleet DO, not inside an ephemeral request function. Suggested starting configuration: ping bucket capacity 60/refill 1 per second per principal, dispatcher reads capacity 30/refill 1, mutations capacity 20/refill 0.5. These are operator tuning suggestions, not measured load limits. Key by `principalRateKey(claims, action)`. Add deployment edge limits for unauthenticated attempts and public demo reads/WS connections. Never trust caller-supplied forwarding headers as IP identity.
7. If returning a protocol with a WS handshake, use a separate safe protocol offered by the client (for example `fleet.v1`) or select none. Never echo `fleet-token.<JWT>`, persist it in WS attachment state, or log it. The token remains visible to the browser/edge during handshake, even though it is not in the URL.
8. Persist verified minimal WS claims and close on expiry using `exp`. Recheck active roles/vehicle grants when revocation support is added; short TTL alone does not revoke a connection. Cap connections and outbound queues, including public demo sockets.
9. Add `Cache-Control: no-store` on every API response, not only errors. Avoid payload/token logs. Use parameterized SQLite calls and fleet-local event_id uniqueness. Restrict public demo routing to the separate demo store.

## Verification actually run

- Strict TypeScript compile of the auth module using the supplied isolated config passed.
- All 23 Node unit tests passed, including independent HMAC token minting, roles/vehicle binding/tenant guards, claim/header/signature/expiry negatives, no query auth, WS protocol/Origin handling, bounded JSON bodies, strict create/patch schemas, rate-limiter refill/key exhaustion/clock rollback and error redaction.
- A failing test exposed role array coercion; fixed before the passing rerun.
- Compiled test output and generated credentials are excluded from the archive.

Only read/reviewed: attached locked contract and parent amendments. Not run: project-wide build/typecheck, Vitest integration, Wrangler/Miniflare, actual Cloudflare deployment, browser handshake behavior, DO alarm socket expiry, API role wiring, storage isolation/replay tests, public/demo separation tests, performance tests or penetration test. Those checks belong to integration; this module is not proof that the service is production-secure.

## QA remediation (second delivery)

- Reject Unicode category C (controls, formatting, private-use, unassigned and lone surrogates), U+2028 and U+2029 in labels. Ordinary visible multilingual letters and spaces remain permitted; tabs/newlines are not permitted in a single-line callsign/label.
- Reject BOM in JSON request bodies and JWT JSON components with ignoreBOM=true (the decoder preserves BOM so JSON.parse rejects it).
- Keep zero iat/nbf/exp leeway by default. Operators minting across slightly different clocks can explicitly backdate iat by 30 seconds: pass nowMs=Date.now()-30000 to issueToken. The total TTL includes that backdating: a 300-second token then has about 270 seconds remaining. Keep fleet API clocks synchronized. Future nbf should not be issued. Expiry is never extended.
- apiErrorResponse adds WWW-Authenticate: Bearer realm="fleet-api" for 401 and Retry-After for 429. ApiError accepts an optional fourth retryAfterSeconds argument; RateLimiter.enforce supplies it. Without metadata the 429 fallback is 1 second. No challenge header is added to 403.
- closeWebSocketAtExpiry(socket, claims, options?) returns cleanup; schedules close(1008, 'Authentication expired') for remaining milliseconds, closes immediately if expired, and rejects a future interval over one hour. Use the returned cleanup on socket close. Timer cannot survive DO eviction/hibernation: persist exp and recheck before every send as well. This is a testable timeout fallback, not a guarantee that a runtime will wake.
- Crew issuance and verification enforce a 15-minute maximum TTL, default 5 minutes. Other roles still have a one-hour maximum.

Verification: strict TypeScript compile and 23 local tests pass. The independently supplied 17-test QA suite was also run after updating its old informational assertion to expect the newly added 401 header. No QA attack assertions were weakened. Both QA runs are included: the first remediation run had 16/17 pass with only its coarse timing threshold failing (125441 vs 80309 ns/op); rerun had 17/17 pass. All functional assertions passed in both. Coarse timing ratios in the QA suite are environment-sensitive observations, not proof of constant-time behavior. No integrated runtime/Cloudflare/browser checks added in this delivery.
