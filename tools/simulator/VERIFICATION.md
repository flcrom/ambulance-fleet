# Run evidence

2026-10-13, Node 22.23.3, npm 10.9.9.

- npm test: 15/15 passed (Vitest 5.0.4).
- npm run typecheck: passed, TypeScript 5.9.3 strict mode.
- npm audit: zero known vulnerabilities at verification time.
- npm run test:live: passed at 2026-10-13T00:07:56.622Z. MBTA route type 3 lookup yielded 150 bus routes; current protobuf yielded 5 valid bus samples; local mock API accepted 10 ping posts (each event replayed once), 5 unique event UUIDs. Stand-in source checked on registration.
- Digitraffic live probe: 2 valid trains mapped; sample train 265, timestamp fallback receipt, 110.016 kph. Probe was fetch/map only, not POST ingestion. CC BY source terms read.
- No real Kafka broker was run. Kafka mapping and commit-after-acceptance were tested using mock callbacks. No Cloudflare, production ingest, UI, or public demo end-to-end tests were run by this lane.
- Original code; no third-party source copied. No GitHub push performed.

Paths delivered: tools/simulator, tools/kafka-bridge, worker/src/feeds only. Kafka-core producer/consumer experiment was removed after clarification to preserve direct-ingest implementation.

## Revision 2

- Reproduced Worker failure: redirect:error unsupported by workerd. Changed to redirect:manual with status checks, including credential-bearing HTTP calls.
- 18/18 tests passed plus strict typecheck; radius/nearest sampling, default 100 cap and manual redirect rejection now tested.
- Live Worker probe 2026-10-13T00:13:58.906Z: raw protobuf HTTP 200, 49,564 bytes; 150 bus routes; 100 nearest valid stand-in bus samples inside 25 km Boston radius. Additional final probe after dependency overrides passed.
- Node live mock test cap remains explicitly five samples (10 replay posts), not a count of the feed.
- Miniflare stable runtime only supports date 2026-08-06. Required deployment date 2026-10-01 not run in this diagnostic.
- Dev-only transitive undici and sharp were overridden to patched releases; npm audit returned zero vulnerabilities after reinstall. No runtime Worker dependencies added.

## Revision 3

- 25/25 tests passed, strict typecheck passed, npm audit zero.
- 8 MiB tiny-varint regression rejects field budget; also run in a Node subprocess with --max-old-space-size=128, returned controlled Error rather than heap kill.
- Regression covers oversized keys, wrong float wire, last scalar, singular-message merge, finite polling configuration, header freshness, nullable motion, movement return epochs and path-consistent synthetic speed/bearing.
- Worker live probe 2026-10-13T00:17:21.435Z: 48,550 bytes, 150 bus routes, 291 bus positions, all 291 missing at least one motion field, 100 selected with missing values null. No missing-motion sample dropped under final contract.
- Node live mock API test 2026-10-13T00:17:18.879Z passed: explicit five sample cap, ten ping posts including replay.
- Prior interim experiment that excluded missing motion selected zero buses and was reverted under the final nullable-motion contract.
- QA archive/report and independent test source inspected; its unmodified test expectations require old invented zero motion/missing headers and are no longer valid contract assertions. Regressions were implemented and run locally; independent QA rerun remains with QA-C.
- Continuity is stateful and bounded, not persisted automatically. Stationary repeated UUIDs do not refresh store timestamps; separate feed-heartbeat freshness remains an integration limitation.

- Final heartbeat integration decision: accepted duplicate updates vehicle.last_seen without another history row. Lane A owns implementation and tests; this lane documents and posts duplicate heartbeats, but has not tested real store heartbeat behavior. Supersedes the unresolved freshness caveat above.

## Revision 4

Initial movement transition uses source device time or feed header, never poll clock. Added regression: identical feed parsed with fresh trackers at now vs now+1s yields identical UUID. 26/26 tests and strict typecheck passed. Same-source restart identity fixed; changed-timestamp restart continuity still requires persisted tracker. No store/deployment retest in this revision.
