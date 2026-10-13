# Lane A: fleet Worker API and storage

Worker + fleet-scoped SQLite Durable Object. Uses lane D `worker/src/auth/index.ts` and lane E `worker/src/rules/index.ts`. Those implementations must be integrated before running. D auth, E v2 rules and C worker feeds are included in this integrated archive; no test doubles.

Files: worker/src/index.ts, worker/src/store.ts, shared/types.ts, wrangler.jsonc, tsconfig.worker.json, tests/api-smoke.mjs.

- `npx tsc -p tsconfig.worker.json`
- Build B's web app into `dist` before `npx wrangler dev --port 8787`.
- Local live testing requires `.dev.vars` with `LIVE_ENABLED=true` and a strong `JWT_SECRET`. Default deployment disables all live endpoints.
- `npx tsc -p security/tsconfig.json`, `node --test security/test.mjs`.
- `JWT_SECRET` environment matching local .dev.vars is required for `node tests/api-smoke.mjs` and `node tests/api-security.mjs`. Tests mint transient short-lived signed test tokens; never print or package them. Fleet ID defaults to random; TEST_FLEET_ID optional.

Verified with actual D JWT and actual E v2: worker typecheck passed, D 17 auth tests passed, E 77 tests passed. 15 API smoke checks passed with signed JWT. Separate runtime regressions passed: invalid/tampered/expired JWT, query-token rejection, unknown registration fields, bridge stand-in registration and device registration denial, bridge live WS denied, missing WS Origin denied, safe fleet.v1 negotiation, JWT WS expiry closes 1008. Initial expiry test exposed local alarm inactivity; fixed using active connection timeout, active heartbeat, alarm fallback and expiry checks before broadcast. Reserved close codes sanitized.

Public stand-in mode: GET /api/demo/fleet?mode=stand_in and /api/demo/events?mode=stand_in. Isolated demo-standin object, snapshot `attribution?:{label:string;source:string;url:string}`, `feed_error?:string`. MBTA fetch attempted no more than every 15s, no synthetic substitution on failure. Local Worker test returns 0 vehicles plus feed_error. Raw feed URL was reachable with curl and returned 49761 bytes, but Worker source ingestion not verified successful. Do not claim live stand-ins work until deployed source fetch succeeds. No fallback to Digitraffic in this store implementation; C parser includes optional tools for it.

Important implementation truth: POST /api/pings directly validates and stores. Optional external Kafka bridge may call this route. This is NOT a Kafka producer/consumer deployment; an architecture diagram depicting Kafka must identify it as target architecture, not verified demo behavior.

Demo data: three explicitly synthetic Bangalore ambulances. Time-based positions update on 5s ticks via snapshot/alarm. The demo writes ping history into SQLite; no mutation endpoint is publicly exposed. No patient fields anywhere. Simulated destination and ETA are advisory straight-line, not routing.

SQLite history retention: maintenance alarm prunes pings older than 7 days when streaming is active. Not a guaranteed timed deletion SLA. No production privacy/compliance claims. Fleet cap is 500 to limit pilot object workload. Additional production work: quotas/rate limits at edge, token issuance/revocation, provisioning/rotation, operator onboarding, backups/restore, retention review, feed adapters, monitoring/load tests and road-routing selection.

WebSocket auth expiry uses verified Claims.exp from D, active connection expiry timeout, 5s heartbeat checks and Durable Object alarm fallback. Local expiry verified. Active timer prevents hibernation while sockets remain, a cost tradeoff for this pilot; load testing pending. Public demo sockets have no claims. Tokens are never echoed as negotiated protocol and never placed in URL. Same-origin calls only; assets response includes noindex and a restrictive CSP. Add the map tile host to img-src if B uses a host other than *.tile.openstreetmap.org.

Original TypeScript implementation.

WebSocket live clients offer [fleet.v1, fleet-token.<JWT>]; server negotiates fleet.v1 only. Demo may omit protocol. Per-principal DO buckets apply ping/read/write limits; public sockets capped 50/object. Edge unauthenticated rate limits remain deployment work.

## Final socket and feed verification
D v2 auth unit tests: 23 pass. E v2 domain tests: 77 pass. Independent QA-A unchanged harness: 60/60 pass with miniflare 4.20260810.0 and workerd 1.20261006.1. Both TCP Bearer JWT and direct dispatchFetch expiry close tests pass. Original hibernating acceptWebSocket path inconsistently removed server socket without client close. Fix: ordinary accept(), explicit Set and WeakMap tracking, active expiry timeout sends auth_expired then close(1008), heartbeat and pre-send expiry checks. 5 consecutive real ws tests observed final frame and 1008 at 1.6-2.0s for 2s tokens. Non-hibernating active sockets are an explicit demo cost tradeoff. No claim of production load readiness.
C v2 feed integration: local Worker stand-in snapshot successfully returned 100 actual MBTA bus positions, source stand_in and MBTA bus callsigns, no feed_error. Uses supported manual redirect mode. Earlier failure was fixed, not hidden.
Independent harness requires QA-only Miniflare/workerd overrides; its evidence and harness are included under qa/, but root deploy package excludes these extra dependencies. To rerun install qa/package.json deps into QA environment and use specified override. No generated secrets/tokens are included.

## Nullable motion and stand-in freshness amendment
Ping speed_kph and heading are number|null. Null is unreported, never 0 or estimated. Validation requires explicit fields; null speed gives unknown ETA; position-only arrival remains usable. Vehicle.last_seen optional is provider-observation heartbeat for stand-ins only. Reobserving stable event updates last_seen without inserting/mutating event/history. Device duplicates never refresh freshness. 10 null/heartbeat rule tests pass; a real JWT store test verifies duplicate last_seen advancement and immutable event/history. Total rules 87 pass, API smoke 16 pass.
C v3 parser integrated; successful local Worker source snapshot returned 100 current MBTA samples with null speed on all 100 and some null heading. Prior old feed vehicles remain labelled and age stale, explaining >100 rows in persisted local test storage. It does not invent motion.
B v2 web merged under web/. Web build and 14 unit tests pass. Vitest upgraded to 5.0.4 to clear dev advisories; web and root npm audit now clean. Assets points web/dist. UI screenshots included from B's mock test, not evidence of full-stack UI rendering.

## Final QA backend remediation
Independent QA-A moving-device-time and stationary-feed harnesses both pass 63/63. Stable public-feed event_id now queries immutable history before updating; same ID never rewrites latest_ping timestamps, only last_seen. Own >15s fixture passes same check. Fresh device ping resolves active stale alert raised before first telemetry. Operational alerts are completely suppressed for stand-ins, which are buses rather than emergency units; public snapshot had 124 retained rows and zero alerts. Alert output is capped 100 newest unacknowledged; older prior feed rows remain labelled and age stale.

B v3 web merged, 18 unit tests and build pass. Vitest upgraded again to 5.0.4; root/web npm audit clean. Final random property run found near-antipodal numerical loss in haversine distance. Replaced central-angle calculation with stable atan2(cross,dot); exact counterexample regression added, no test tolerance weakened. Rules 88 tests passed five consecutive randomized runs, worker typecheck passes. No full-stack visual rendering/deploy was performed by A; B screenshots included as source evidence only.

## Final clean-checkout run (B v4)
Copied source to a clean folder excluding node_modules, build output, .wrangler, .dev.vars and generated token code. npm ci, root npm test (rules88/auth23/tools26 + tool typecheck), Worker typecheck, root build and web18 tests all pass. Separate Chromium mock e2e 10/10 pass. Root Vitest config avoids accidentally discovering Playwright/web tests; web has its own dependencies. Vitest5 upgrade retained to clear advisories. Test-induced rejected/closed mock WebSockets print Vite ECONNRESET/socket hang-up, without failing e2e. These e2e tests use B's mock API, not a deployed service. QA-A and QA-B independently reported PASS via parent.
