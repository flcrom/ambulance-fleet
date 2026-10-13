# Ambulance fleet tracking prototype

## Built
TypeScript Worker API, fleet-scoped SQLite Durable Object storage and React dispatcher UI. The implementation is **direct ingest**: authenticated ping -> validation -> immutable history/latest-state store -> fleet snapshot/WebSocket. Vehicle roles/scopes, replay deduplication, stale telemetry, advisory arrival geofence and straight-line ETA are implemented. Nullable speed/heading stay unknown; no estimated provider motion or patient/clinical data.

Public demo has synthetic ambulances and separately labelled live MBTA **stand-in buses, not ambulances**. MBTA / MassDOT attribution links to https://www.mbta.com/developers/gtfs-realtime. Map tiles retain OpenStreetMap attribution and share viewer IP with the tile provider. Bus source/callsign survive ingestion; no fake emergency operational alerts for buses. Stand-in repeated observations update last_seen without rewriting immutable events. Feed failure remains visible, never replaced with synthetic live claims.

## Designed only
Kafka-core architecture is a target design: producer-side ingestion -> broker/topic -> rules consumer -> storage -> dispatcher. The broker deployment, core producer path and core rules consumer are **not built or running** in this prototype. The optional tools/kafka-bridge reads an existing driver_locations topic and calls direct ingest, but it is not a deployed Kafka backbone. Its tests mock Kafka delivery; no actual broker end-to-end verification.

Concept credit: https://github.com/Vedant62/geolocation-telemetry-backend at commit 0904030987584d1aa4193c9ba5f0ea6ea379e235. Clean implementation, no source copied (no license found in inspected upstream tree), no upstream repository changes.

## Local run
Node 22+, npm:

```sh
npm ci
npm run build
npm run typecheck:worker
npm test
npm --prefix web test
npx wrangler dev --port 8787
```

Open http://localhost:8787. Build output is web/dist and Worker ASSETS points there. Root npm test runs rules, auth and tool suites only; Playwright is separate:

```sh
cd web
npx playwright install chromium
npm run test:e2e
```

Public default demo is synthetic. Select live stand-ins for MBTA buses. /api/demo/fleet?mode=stand_in and matching /api/demo/events are isolated from live fleets. Live API defaults disabled. Local-only `.dev.vars` must contain LIVE_ENABLED=true and an operator-generated JWT_SECRET of at least32 random bytes for real-device testing. Never commit .dev.vars, tokens or secrets. Mint short-lived tokens through operator-only auth.issueToken (not a public signup endpoint). Crew binds one vehicle; dispatcher administers the fleet; bridge can register stand-in sources only. Test scripts mint transient tokens when JWT_SECRET environment matches local runtime.

## Deploy
Use the verified owner account and private source repo. Review account limits/billing before deployment. Authenticate Wrangler through the operator's authorized account route, then:

```sh
npm ci
npm run build
npm test
npm run typecheck:worker
npx wrangler deploy
```

SQLite Durable Object migration v1 is in wrangler.jsonc. Deployment starts with LIVE_ENABLED=false and no live secret. If explicitly approved for live use, configure JWT_SECRET through the host's secret mechanism, provision fleet/roles, then enable live. Never expose real fleet data through public demo routes. Custom domain requires verified DNS ownership and a separate approved binding, not a guessed URL. Set noindex remains enabled via HTML/API headers.

## Limits and verification
This is a prototype, not an ambulance emergency-dispatch service. ETA is straight-line advisory, not road/traffic-aware or response-time prediction. No ambulance booking, clinical triage, emergency operational guarantee, regulatory-compliance certification or real ambulance rollout. Production work includes token issuance/revocation, onboarding, edge quotas, privacy/retention, backup/restore, monitoring, load tests and routing provider review.

WebSocket expiry uses normal accept sockets plus active timers and pre-send checks; no hibernation while connections are active, a cost tradeoff. Per-principal in-memory limiters are pilot safeguards, not distributed edge protection. History pruning is activity-driven, not a deletion SLA.

Verification logs and details: README-LANE-A.md; web/VERIFICATION.md; security/README.md; tools/simulator/VERIFICATION.md. Independent QA-A and QA-B reported PASS, after fixes for auth expiry propagation, immutable feed events, stale alerts, unknown motion, snapshot rejection, phone labels and focus restoration. Local runtime verified100 actual MBTA bus observations, not real ambulance telemetry. Deployment/live UI verification is a separate step, not claimed by source-package delivery.
