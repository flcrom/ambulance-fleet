import { arrival, isStale, pingFreshnessMs, STALE_MS } from './vehicle';
import type { Alert, Vehicle } from './types';

const isOpen = (a: Alert, v: string, k: Alert['kind']) => a.vehicle_id === v && a.kind === k && a.acknowledged_at === null;

/**
 * Returns alerts to create now (usually 0 or 1). Pure; `newId` is injected.
 * - stale: one alert per stale episode. Suppressed while an unacknowledged stale alert exists, and
 *   after acknowledgement for the same episode (any stale alert created since the last fresh ping).
 *   A new episode begins when a fresh ping arrives and the vehicle later goes stale again.
 * - arrival: only while the latest ping is fresh (not offline); fires on the outside->inside transition relative to `previous` (the vehicle before this
 *   ping was applied). No transition (including reordered pings that did not move latest) means no alert.
 *   Suppressed while an unacknowledged arrival alert exists. Never alters vehicle status.
 */
export function evaluateAlerts(
  vehicle: Vehicle, previous: Vehicle | null, existing: readonly Alert[], nowMs: number,
  newId: () => string,
): Alert[] {
  const out: Alert[] = [];
  const created_at = new Date(nowMs).toISOString();
  const p = vehicle.latest_ping;

  if (isStale(p, nowMs) && !existing.some(a => isOpen(a, vehicle.id, 'stale'))) {
    // Never-pinged or malformed timestamps: one alert per vehicle (episode start unknown = -Infinity).
    const f = p ? pingFreshnessMs(p) : NaN;
    const episodeStart = Number.isFinite(f) ? f + STALE_MS : -Infinity;
    const already = existing.some(a => a.vehicle_id === vehicle.id && a.kind === 'stale' && Date.parse(a.created_at) >= episodeStart);
    if (!already) out.push({ id: newId(), vehicle_id: vehicle.id, kind: 'stale', created_at, acknowledged_at: null,
      message: `${vehicle.callsign}: no position update for over 30 s` });
  }

  if (!isStale(p, nowMs) && arrival(vehicle) && !(previous && arrival(previous)) && !existing.some(a => isOpen(a, vehicle.id, 'arrival'))) {
    out.push({ id: newId(), vehicle_id: vehicle.id, kind: 'arrival', created_at, acknowledged_at: null,
      message: `${vehicle.callsign}: within 150 m of ${vehicle.destination?.label ?? 'destination'} (straight-line, advisory)` });
  }
  return out;
}

/** Idempotent: re-acknowledging keeps the original timestamp. Returns a new object. */
export function acknowledge(alert: Alert, nowMs: number): Alert {
  return alert.acknowledged_at ? alert : { ...alert, acknowledged_at: new Date(nowMs).toISOString() };
}
