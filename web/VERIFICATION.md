# Lane B verification

2026-10-13: Ran production build (TypeScript + Vite), separate typecheck, 18 Vitest tests and 10 Chromium end-to-end tests. All passed after the nullable speed/heading amendment.

Null speed/heading are accepted in runtime snapshot/history validation and never replaced with zero. MBTA mock fixtures emit nulls. Browser assertions verify Speed unknown, ETA unknown, and selected-vehicle Speed/Heading Unknown. ETA is suppressed if speed is null even when an inconsistent API snapshot includes ETA.

Actual desktop (1440px), phone (390px) and narrow phone (320px) screenshot pixels were inspected. Desktop and phone synthetic views show map markers and attribution; stand-in shows BUS, Speed unknown, ETA unknown and feed attribution. Phone replay/detail controls wrap without overflow after adding speed and heading.

Other exercised flows: source switch, public read-only alerts, dispatcher WebSocket protocol, history playback, acknowledgment, logout, failed-WS polling, expired auth, feed failure with no synthetic substitution. Unit tests cover visibility pause, backoff, socket silence and malformed/reordered snapshots. Intentional rejected/aborted sockets can cause a Vite proxy reset log. Main browser flow has zero page errors.

Not run: Worker/Durable Object integration, real JWT verifier, actual MBTA feed, Cloudflare deployment or production endpoint verification. The mock is test-only, not a service or live feed.

V3 QA fixes rerun: build, separate typecheck, 18 unit tests, 10 Chromium tests all passed. Added future-time bound/recovery and reconnect ordering reset tests, vehicle-level isolation, server-relative age under a two-minute client clock lead, REST/WS expiry clearing rows, long-string wrap/viewport checks, focus trap/Escape and computed 4.5:1 text contrast checks. Actual refreshed desktop, 390px and 320px pixels inspected. Zoom outlines and selection line are monochrome 1px; repeated ETA guide text removed. Independent QA real Worker runs are not claimed as this lane's execution.

V4: mode stays visible on phone; modal-close focus returns to sign-in. Build/typecheck, 18 Vitest and 10 Chromium tests rerun successfully. Added mode visibility and trigger focus assertions. Updated 390px and 320px actual screenshot pixels inspected. Everything else unchanged from v3.
