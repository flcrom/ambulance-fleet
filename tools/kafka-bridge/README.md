# Optional Kafka adapter

This is not required for the simple deployed API. driver_locations -> bridge -> authenticated POST /api/pings -> durable store. The architecture diagram may place Kafka at the core, but this implementation does not change the API into a Kafka producer or create a broker.

Install and run from tools/simulator:

```sh
npm ci
KAFKA_BROKERS=broker.example:9093 KAFKA_GROUP_ID=fleet-bridge FLEET_API_URL=https://your-api.example FLEET_TOKEN="$BRIDGE_TOKEN" DRIVER_VEHICLE_MAP='{"driver-1":"vehicle-1"}' npm run kafka
```

TLS is on by default. KAFKA_TLS=false is only for a trusted local plaintext development broker. Optional KAFKA_SASL_MECHANISM=plain|scram-sha-256|scram-sha-512, KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD support authenticated brokers. Supply secrets via operator environment, never commit them. Vehicles must already exist; the adapter does not register them. FLEET_TOKEN selects the authorized fleet.

- Legacy value {user_id,lat,lon}: vehicle mapped by DRIVER_VEHICLE_MAP, recorded_at = bridge receipt time, telemetry_time="receipt", speed/heading = null (unknown). It does not claim device-recorded time.
- Modern value: full PingInput including telemetry_time. Timestamp and motion preserved. event_id is replaced by stable topic/partition/offset identity so replay uses the same UUID.
- UUID is a deterministic RFC 9562 version 8 UUID from SHA-256, 36 characters. Arbitrarily large offsets use BigInt.
- autoCommit:false and eachBatchAutoResolve:false. Offset+1 commits only after exact API accepted:true confirmation with matching event_id and boolean duplicate flag. Accepted duplicates count as success. API failures, parse errors, validation errors and unmapped drivers stop processing without commit; no silent skips or automatic DLQ discard.
- A crash between API acceptance and commit replays safely via event_id deduplication. Legacy replay receipt time can differ, but identity remains stable; the store must deduplicate before applying payload.
- SIGINT/SIGTERM disconnect gracefully. HTTP timeout is 10 seconds, redirects are refused to avoid credential forwarding. Token is not logged.

Tested with mocked consumption/commit callbacks and an actual local mock HTTP API, not a running Kafka broker. Poison-message remediation is an operator task; do not reset offsets without reviewing rejected messages.
