# Missing telemetry provenance patch

POST /api/pings input without telemetry_time is normalized to telemetry_time:'receipt' and recorded_at=the server validation receipt clock. Explicit device/receipt records keep their supplied timestamp. Input timestamp is still validated before normalization so invalid/future/out-of-range dates are not silently accepted.

Stored Ping type requires explicit telemetry_time. Ingest helper and store enforce it, receipt replay compares immutable identity/content without treating changed receipt timestamps as conflicts. Pre-patch stored events are projected consistently in both snapshot and history as receipt, recorded_at=received_at, without rewriting immutable storage rows. This prevents previously accepted legacy vehicles from disappearing in the UI after deploying the patch.

Regression tests: missing provenance uses server clock and receipt label; explicit device timestamp preserved; real signed-JWT API legacy ping output has valid provenance and remains present. Rules fixture for ordering properties now explicitly marks device events to keep device-order semantics testable.

Verified: Worker typecheck passed; root suites rules90/auth23/tools26 pass; web18 pass; signed-JWT API smoke17 pass. No deploy performed. Changed files only are included for patching the final source. Rebuild and redeploy through the authorized deployment lane.
