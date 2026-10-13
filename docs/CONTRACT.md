# Fleet v1 contract (merged 2026-10-13)

Implementation: TypeScript, Vite/React dispatcher; Cloudflare Worker API + one SQLite Durable Object per fleet. Original implementation. Kafka is an optional bridge, not a required demo dependency.

## Layout and ownership
- Lane A: worker/index.ts, worker/store.ts, shared/types.ts, wrangler.jsonc, package.json, tsconfig.json, API/storage tests
- Lane B: src/**, index.html, vite.config.ts (React UI)
- Lane C: scripts/simulate.ts, scripts/kafka-bridge.ts, scripts/README.md
- Lane D: worker/auth.ts, tests/auth.test.ts, SECURITY.md
- Lane E: worker/domain.ts, tests/domain.test.ts
- Root README assembled by main/integration, builders supply their run notes.

## Records
All timestamps ISO 8601 UTC, lat/lon decimal degrees, speed_kph nonnegative km/h or null when unreported; heading degrees or null when unreported. Never coerce unreported motion to 0 or estimate motion. No patient data.

Vehicle:
`{id:string, callsign:string, type:'BLS'|'ALS', status:'available'|'en_route'|'at_scene'|'transporting'|'at_hospital'|'offline', destination: {label:string,lat:number,lon:number}|null, latest_ping:Ping|null, stale:boolean, eta: {minutes:number,method:'straight_line',approximate:true}|null}`

Ping input:
`{event_id:string, vehicle_id:string, recorded_at:string, lat:number, lon:number, speed_kph:number|null, heading:number|null}`
Stored Ping adds `received_at:string`. event_id is UUID (36 chars). heading 0 <= heading < 360. Reject non-finite coordinates, out-of-range lat/lon, speed > 200, recorded_at > 60s future or >24h old. Immutable ping history; latest is updated only if recorded_at is newer. event_id deduplication scoped to fleet. Stale threshold 30s. All changes have server received time.

Alert:
`{id:string, vehicle_id:string, kind:'stale'|'arrival', created_at:string, message:string, acknowledged_at:string|null}`
Arrival is advisory geofence radius 150m, does NOT alter vehicle status. No clinical alerts. No route/path implies road routing.

Fleet snapshot:
`{fleet_id:string, mode:'demo'|'live', server_time:string, vehicles:Vehicle[], alerts:Alert[]}`

## Endpoints
Same-origin. All responses Cache-Control:no-store; API errors `{error:{code:string,message:string}}`.
- GET /api/health -> `{ok:true,version:'1',mode:'demo'|'live'}`
- GET /api/demo/fleet -> public synthetic snapshot (live fleet never exposed here)
- GET /api/demo/events -> public synthetic WebSocket. Initial and subsequent messages `{type:'snapshot',data:FleetSnapshot}`. UI may fallback to GET every 5s, stops/retries with backoff when not visible.
- POST /api/demo/reset -> disabled publicly; simulation owned by server using fixed seeded paths and wall-clock time. No unauthenticated arbitrary writes.
- GET /api/fleet -> authenticated dispatcher/bridge snapshot
- GET /api/events -> authenticated dispatcher WebSocket, same schema. Browser uses Authorization via short-lived token in Sec-WebSocket-Protocol `fleet-token.<JWT>` (not URL). Poll fallback uses Authorization Bearer.
- POST /api/vehicles -> dispatcher only, input `{id,callsign,type}`, 201 Vehicle; conflict 409
- PATCH /api/vehicles/:id -> dispatcher only, input `{status?,destination?}`; status offline is derived only, cannot be set. 200 Vehicle
- POST /api/pings -> crew/bridge only, Ping input; 201 `{accepted:true,duplicate:false,event_id}` or 200 duplicate:true. Unknown vehicle 404. Crew vehicle binding enforced. Older/reordered valid events persist but never rewind map.
- GET /api/vehicles/:id/history?limit=100 -> dispatcher only, `{pings:Ping[]}` newest recorded_at first; limit 1..500
- POST /api/alerts/:id/ack -> dispatcher only, 200 `{acknowledged:true}`

Only live API enabled when LIVE_ENABLED='true' and JWT_SECRET configured. Auth failure 401, wrong role/vehicle 403. Demo is separate fleet `demo`; live auth cannot access `demo`.

## Auth module contract (D)
Export `authorize(request:Request, env:AuthEnv):Promise<Claims>`; throw `ApiError` with status and code. Export `ApiError` constructor `(status:number,code:string,message:string)`. Export `type AuthEnv={JWT_SECRET?:string;LIVE_ENABLED?:string}` and `type Claims={sub:string;fleet_id:string;role:'dispatcher'|'crew'|'bridge';vehicle_id?:string}`.
HS256 JWT with exp/iat, iss='ambulance-fleet', aud='fleet-api'. Crew requires vehicle_id. Bridge is service identity, allowed to post for existing vehicles only. No public self-register or baked-in secret. Dev token helper in scripts permitted ONLY explicit operator invocation with JWT_SECRET, do not commit generated tokens.

## Domain module contract (E)
Export `validatePing(value:unknown, nowMs?:number): PingInput` (throws Error on invalid).
Export `distanceMeters(a:{lat:number,lon:number},b:{lat:number,lon:number}):number`.
Export `deriveVehicle(vehicle:Vehicle, nowMs?:number):Vehicle` fills stale and eta (null if no destination/stale/speed=null/speed<5). Any speed-dependent alert skips null values. Straight-line ETA cannot be called response-time prediction. Export `arrival(vehicle:Vehicle):boolean` checks latest within destination 150m. Status offline derived after 30s; stored operational status must remain for reconnect.

## Runtime vars
JWT_SECRET secret (>=32 random bytes), LIVE_ENABLED default false. FLEETS Durable Object binding class FleetStore. Assets binding ASSETS to dist. No map API key required for demo. OSM tiles must preserve attribution; external tiles receive viewer IP, never patient data. Production routing provider is deliberately not selected.
Bridge vars: KAFKA_BROKERS, KAFKA_GROUP_ID, FLEET_API_URL, FLEET_TOKEN, DRIVER_VEHICLE_MAP JSON. Legacy driver_locations payload `{user_id,lat,lon}` has no timestamp: bridge must mark ingestion receipt time, must not claim device-recorded time. Modern schema supports full PingInput. Kafka commit AFTER accepted API response; stable event_id from topic/partition/offset for replay. Use a deterministic UUID hash, never random ID for redelivery.
Simulator vars: FLEET_API_URL, FLEET_TOKEN; three synthetic vehicles registered by dispatcher separately. API server owns read-only demo movements independently.

## Commands
npm install; npm run build (tsc + vite); npm test (vitest run); npm run dev (wrangler dev, serves built dist); npm run typecheck.
wrangler config uses compatibility date 2026-10-01, SQLite migration v1. No deploy without verified account, private source repo, free-tier authority check. Deploy command `npx wrangler deploy` in authorized lane.

## Final merged amendments
Paths: worker/src/index.ts and store.ts; auth/rules/feeds each worker/src/<lane>/index.ts; UI web/.
Vehicle.source:'device'|'synthetic'|'stand_in' required. Synthetic demo is not a device observation. Stand-in data is buses/trains, never ambulances. Ping.telemetry_time:'device'|'receipt' optional input defaults receipt, using server receipt clock; stored/output provenance always explicit. Legacy Kafka uses receipt and null motion. Fixed receipt replay must not change immutable stored event.
Public modes: /api/demo/fleet?mode=stand_in and /api/demo/events?mode=stand_in isolate demo-standin; default mode synthetic isolated demo. Snapshot attribution?:{label:string;source:string;url:string}, feed_error?:string. No public writes/history/ack.
Live browser WS clients offer fleet.v1 plus fleet-token.<JWT>; server selects fleet.v1 only. Dispatcher-only, Origin required. Active accept sockets, expiry frame {type:'auth_expired'} before close(1008), TTL checks before each send.
Implementation is direct ingestion -> Durable Object. Kafka-core diagram is target architecture, not a claimed broker implementation.

Vehicle.last_seen?:string is stand-in provider observation heartbeat only. Successful repeated feed observation updates last_seen without changing immutable event/history. Stand-in staleness uses this heartbeat; device replay never uses it.
