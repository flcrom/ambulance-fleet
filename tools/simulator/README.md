# Fleet feed tools (Lane C)

Original TypeScript implementation; no code copied from Vedant62 repositories. Origin of the project idea: Vedant62/geolocation-telemetry-backend at 0904030987584d1aa4193c9ba5f0ea6ea379e235. Those repositories were not read or modified in this lane.

## Install and verify

From the project root:

```sh
cd tools/simulator
npm ci
npm test
npm run typecheck
npm run test:live
npm run test:worker
```

This is a self-contained tool package. It owns no root package or shared types. The worker-facing parser in worker/src/feeds has no Node dependencies and can be imported directly. Structural FeedPing is the agreed shared PingInput shape including telemetry_time. Merge with shared/types.ts during integration if desired. No UI or spatial artifact is produced here.

## Synthetic ingestion

Register SYNTHETIC_VEHICLES exported from simulator.ts using a dispatcher token first, with source:"synthetic". Then run with a bridge token:

```sh
FLEET_API_URL=https://your-api.example FLEET_TOKEN="$BRIDGE_TOKEN" ONCE=true npm run simulate
```

Omit ONCE for 5-second posting. The three fixed seeded loops are approximate synthetic motion, not road routing. This tool never calls public /api/demo/reset or writes to the public demo API. The API server must call syntheticPings itself for the read-only public demo. Event UUIDs are stable per seed, vehicle and UTC second. Synthetic telemetry_time is receipt, never a claim of device measurement.

## Live stand-in ingestion

```sh
FLEET_API_URL=https://your-api.example FLEET_TOKEN="$FEED_TOKEN" ONCE=true npm run feed
```

Default polling is 15 seconds, no overlapping requests. FEED_INTERVAL_MS allows 10000..15000 only. The adapter registers source:"stand_in" vehicles using the agreed feed bridge identity, then posts pings. If the server has not implemented feed-only bridge registration, pre-register with a dispatcher or use the worker parser callback directly. API source and callsign must survive into the UI. POST acceptance is checked, not inferred from any 2xx response.

MBTA bus route allowlist is fetched from API v3 (route type 3) and refreshed daily. This avoids mislabelling subway/rail vehicles from the mixed VehiclePositions feed. Default selection is all valid buses within 25 km of Boston centre (42.3601,-71.0589), capped at 100 nearest buses. Stable ID only breaks distance ties. This is a geographic sample, not full system coverage. FEED_CENTRE_LAT and FEED_CENTRE_LON together, FEED_RADIUS_KM and FEED_MAX_VEHICLES configure the CLI; the Worker parser accepts centre/radiusKm/maxVehicles directly. The five buses in test:live are an explicit mock-test cap, not the feed size. Digitraffic backup defaults to 100 with no Boston radius and retains its honest train labels. A missing speed or bearing is null per the revised contract; no zero or estimate is substituted. UI must show unknown; ETA and speed-dependent rules skip unknown speed. Timestamp is device when present; otherwise receipt. Stale/out-of-range data is excluded rather than made fresh. BLS is only the contract-required schema placeholder for stand-ins, not bus clinical capability. The UI must label: "live stand-in vehicles (MBTA buses), not ambulances".

Set DIGITRAFFIC_FALLBACK=true to enable fallback on MBTA fetch/route failure. The backup is Finnish trains, not buses or ambulances. Its separate IDs/callsigns and logs identify the provider. UI attribution must change with provider, and any old MBTA markers must remain identifiable, then age out normally. Existing fleet source/callsign conflicts are checked by authenticated snapshot before reusing an ID; a mismatch stops ingestion.

Sources and display requirements:

- MBTA protobuf: https://cdn.mbta.com/realtime/VehiclePositions.pb
- MBTA bus routes: https://api-v3.mbta.com/routes?filter%5Btype%5D=3
- MBTA developer terms / MassDOT license link: https://www.mbta.com/developers/gtfs-realtime
- GTFS-RT field reference: https://raw.githubusercontent.com/google/transit/master/gtfs-realtime/proto/gtfs-realtime.proto
- Digitraffic train feed: https://rata.digitraffic.fi/api/v1/trains/gtfs-rt-locations
- Digitraffic feed documentation: https://www.digitraffic.fi/en/railway-traffic/
- Digitraffic terms: https://www.digitraffic.fi/en/terms-of-service/
- Display: "Source: Fintraffic / digitraffic.fi, license CC BY 4.0", with https://creativecommons.org/licenses/by/4.0/ and note "Locations mapped to fleet ping schema". Label "live stand-in vehicles (Digitraffic trains), not ambulances".

## Verification scope

Run results are recorded in VERIFICATION.md. Unit/mock tests and live source probes were run. Local workerd/Miniflare live fetching was verified with compatibility date 2026-08-06 (installed stable runtime cannot start 2026-10-01). No Cloudflare deployment, production API, UI, actual Kafka broker, or end-to-end Kafka delivery was run. MBTA positions were posted to a local mock API only. The minimal protobuf reader is original and handles the required GTFS fields, skipping unknown supported-wire fields; it is not a general-purpose protobuf library. Feed reads are capped at 8 MiB; malformed protobuf fails the poll.

## Worker fetch fix

Workers reject redirect:"error" before making a network request. Every feed/ingest fetch now uses redirect:"manual" and rejects non-success responses, so redirects are not followed. Verified raw ArrayBuffer, route JSON, capped stream reads and protobuf parsing inside workerd. Live source had no Content-Encoding, so no decompression path was implicated; compressed-source behavior was not separately tested.

## V3 safety and event semantics

Streaming scanner skips unknown fields without field-object allocation and shares a 30,000-field budget across envelope/nested scans. Input is also capped at 8 MiB. Public fields() inspection helper has a 20,000-field cap. Keys above uint32 reject before conversion, float wire type is strict, duplicate scalar last wins, embedded message fragments merge. Header version 1.0/2.0 and a safe integer timestamp within 60 seconds of current time are mandatory; absent/stale headers reject instead of making cached telemetry fresh. Entity IDs are required. Legacy groups remain unsupported.

Stationary identity uses exact decoded float32 lat/lon/bearing/speed including null, with no rounding or fuzzy threshold. A PositionTracker retains the current signature and UUID per provider+vehicle. Same consecutive signature keeps its UUID despite newer timestamp; changed signature starts a new movement epoch, so returning after a change gets a new UUID. Caller may supply/persist tracker; default is bounded in-memory (2,000 vehicles, expires idle entries after 24h), so restart/eviction loses continuity and may emit a new event. Initial movement epoch is derived from source device timestamp, or fresh feed header when device timestamp is absent, never poll time. Identical immutable feed content yields the same UUID across fresh trackers. A changed source timestamp across restart can still emit a new UUID for unchanged motion because previous continuity was lost. Returning after an intervening move gets a new epoch while tracker survives. This is bounded continuity, not durable exactly-once identity.

Freshness is distinct from movement. Final integration contract (Lane A): an accepted duplicate event_id does not add immutable history, but updates vehicle.last_seen heartbeat so stale reflects continuing feed receipt rather than motion changes. Adapter posts stationary repeated UUIDs normally; store must preserve history and latest_ping while updating heartbeat. This lane does not implement store behavior; Lane A owns and tests it.

Numeric environment is validated before polling: finite values, centre both coordinates, cap integer 1..100, interval 10,000..15,000 ms. Minimum delay is 10 seconds and polls are sequential. HTTP 429 exits unless fallback enabled; no Retry-After backoff implemented.

Synthetic speed and bearing derive from the next one-second path delta using local geodesic scaling, so they match the generated path rather than arbitrary phase or fixed speed.
