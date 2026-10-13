# Fleet dispatcher UI (lane B)

Clean React + TypeScript implementation in `web/`. Original implementation.

## Run

Node 22 or later:

```sh
cd web
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:e2e
```

The browser test command starts and stops Vite on port 5173 and the mock API on 8788. To explore manually, start `npm run mock` and `npm run dev` in separate terminals. Open http://localhost:5173. Mock dispatcher token: `mock.dispatcher.token`. This is an intentionally invalid JWT-shaped test fixture, not a credential. Never deploy `mock/server.mjs`: it is not an authentication implementation or a public-feed adapter.

## Integrate

Keep this complete directory under `web/`. This module has its own package/lock/tsconfig and does not edit root package configuration or other lanes. Build output is `web/dist`; integration must point the Worker ASSETS binding to that directory, or copy it into the root dist directory during root build. The dev proxy targets the mock port only; point it to the Worker port for full-stack local work. Production requests are same-origin relative `/api/...` paths.

`src/types.ts` is a local interface mirror for independent development. It includes the final source/time additions (`Vehicle.source:device|synthetic|stand_in`, `Ping.telemetry_time:device|receipt`, nullable `speed_kph` and `heading`), `{label,source,url}` attribution and string feed_error. Integration can replace its interfaces with type-only imports from `shared/types.ts`, keeping its runtime validation functions.

WebSockets offer `fleet.v1` in all modes; live mode additionally offers `fleet-token.<JWT>`. The server must negotiate only `fleet.v1`. Polling and history/ack use Bearer headers, never URL tokens. Token state is memory-only and is cleared on sign-out/reload; no token generation, local/session storage, or auto-renewal.

Default public demo is synthetic. The source selector uses `/api/demo/fleet?mode=stand_in` and matching event path for the separate `demo-standin` fleet. Feed errors are shown without synthetic substitution. Stand-in rows say MBTA bus and BUS, not ALS/BLS. Their public-feed provenance is visible beside the map. Demo history and acknowledgment are disabled because the contract only grants those endpoints to dispatchers.

Authenticated history is fetched newest-first, sorted oldest-first for replay, and never substituted for the live state. The dashed replay line connects recorded points, not a road route. History requests that finish after a vehicle/token change do not apply to the new selection.

OSM attribution stays visible. Tiles are fetched from tile.openstreetmap.org, which receives the viewer IP. No patient fields exist in this UI.

## Verified by running

- `npm run build`: TypeScript and Vite production build passed.
- `npm test`: 18 tests passed (API errors, headers and endpoints, validation, labels, history order, WebSocket token protocol/URL separation, polling at 5 seconds, failure backoff, visibility pause/resume, silent-socket watchdog, unauthorized stop, malformed messages, older snapshot rejection).
- `npm run test:e2e`: 10 Chromium tests passed against the mock API. Covers public source switch and provenance, disabled public ack, dispatcher WebSocket connection, history play/pause, acknowledgment, sign-out, polling when WebSocket rejects, empty stand-in feed failure without substitution, expired access, no token persistence, and no viewport overflow at 390px and 320px.
- Inspected actual running-UI screenshots at desktop 1440px and phone 390px, plus 320px failure state. Map tiles, vehicle markers, attribution, alerts and replay controls rendered. Fixed a map fit/remount bug caught in screenshots and a Leaflet teardown animation error caught by browser tests.
- The final full run passed with no browser page errors in the main flow. Vite can print EPIPE/ECONNRESET/socket hang-up during deliberately rejected or aborted mock WebSocket connections.

Evidence is in `screenshots/`. Stand-in vehicle screenshots use an explicitly labelled mock fixture, not a real MBTA feed.

## Nullable telemetry amendment

Provider-absent speed and heading remain null. The UI shows Speed unknown, Heading Unknown and ETA unknown instead of zero or estimates; ETA is hidden even if an inconsistent snapshot supplies it with null speed. Mock MBTA fixtures emit null for both. Unit validation and Chromium source-switch/detail assertions were rerun for this amendment.

## Not run / integration work remaining

No Worker/Durable Object integration, real JWT verification, actual MBTA feed fetch, Cloudflare deployment, live ambulances or production endpoint tests were run. Only the supplied contract and later exact additions were read for these dependencies. Real service permissions, durable alert behavior, backend freshness and bridge data are owned by other lanes. Production OSM capacity/policy review is not validated here. No create-vehicle/status-edit UI was requested or implemented.

## QA revision v3

Snapshots more than five minutes away from the browser wall clock are rejected before ordering changes. The five-minute allowance tolerates ordinary device skew (including the tested two-minute lead); clocks farther off result in an explicit feed error rather than fabricated timestamps. Ordering resets on reconnect. Invalid vehicle records are omitted independently, without zero/estimated replacement, while the valid envelope and other vehicles remain usable.

Freshness uses server_time minus recorded_at plus monotonic elapsed time since snapshot receipt, never local wall-clock subtraction. Auth 401/403 or live WS close 1008 clears rows/history immediately and stops transport.

Unbroken labels wrap; map tooltips truncate at 180px. Text metadata is at least 12px with #555 or darker against white; automated computed-color assertions cover metadata and the footer. Modal Tab cycles through its controls and Escape closes from any control. Public alert button accessible name includes its visible Read only label. Repeated ETA/advisory guide text removed; footer has a single ETA is not a response-time prediction line. Selected rows use a 1px inset line, not a fill. Zoom controls use a 1px outline and transparent background.

Expanded tests exercise future-time recovery, malformed-vehicle isolation, wall-clock skew, long 200-character strings at 1440/390/320, contrast and text size, focus trap/Escape, REST and WS expiry after rows existed, and normal 320px layout. Independent QA evidence was read to reproduce issues; its real Worker tests were not rerun here.

## QA revision v4

Only the requested final UI fixes changed: Public demo / Dispatcher remains visible below 760px, and closing the access modal returns focus to the sign-in trigger. Browser assertions verify the visible mode at 390px and focus return after Escape. Build, typecheck, 18 unit and 10 browser tests rerun successfully. Updated 390px and 320px actual screenshots inspected.
