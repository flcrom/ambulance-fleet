import { distanceMeters } from './geo';
import { parseIsoUtc } from './validate';
import type { Eta, Ping, Vehicle } from './types';

export const STALE_MS = 30_000;
export const ARRIVAL_RADIUS_M = 150;
export const MIN_ETA_SPEED_KPH = 5;

/**
 * Freshness time of a ping: the OLDER of recorded_at and received_at, so neither a
 * replayed old event (recent receipt) nor a skewed device clock (future recorded_at)
 * makes a vehicle look fresher than it is. Unparseable -> NaN (treated as stale).
 */
export function pingFreshnessMs(p: Ping): number {
  return Math.min(parseIsoUtc(p.recorded_at), parseIsoUtc(p.received_at));
}

export function isStale(p: Ping | null, nowMs: number = Date.now()): boolean {
  if (!p || !Number.isFinite(nowMs)) return true;
  const t = pingFreshnessMs(p);
  return !Number.isFinite(t) || nowMs - t > STALE_MS;
}

/** Straight-line ETA only. Advisory, approximate; not a response-time prediction. Whole minutes, rounded up. */
export function straightLineEta(v: Pick<Vehicle, 'destination' | 'latest_ping'>): Eta | null {
  const p = v.latest_ping, d = v.destination;
  if (!p || !d || p.speed_kph === null || ![p.lat, p.lon, p.speed_kph, d.lat, d.lon].every(Number.isFinite) || p.speed_kph < MIN_ETA_SPEED_KPH) return null;
  const hours = distanceMeters(p, d) / 1000 / p.speed_kph;
  const minutes = Math.ceil(hours * 60);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return { minutes, method: 'straight_line', approximate: true };
}

/** True when the latest ping is within 150 m of the destination. Does not change status. */
export function arrival(vehicle: Vehicle): boolean {
  const p = vehicle.latest_ping, d = vehicle.destination;
  if (!p || !d || ![p.lat, p.lon, d.lat, d.lon].every(Number.isFinite)) return false;
  return distanceMeters(p, d) <= ARRIVAL_RADIUS_M;
}

/**
 * Fills stale, eta and derived offline status. Pure: returns a new object.
 * Stored operational status is only masked in the output; callers must persist the
 * ORIGINAL status, so it returns on reconnect. A stored 'offline' (should not occur) is kept.
 */
export function deriveVehicle(vehicle: Vehicle, nowMs: number = Date.now()): Vehicle {
  const observed=vehicle.source==='stand_in' && vehicle.last_seen?parseIsoUtc(vehicle.last_seen):NaN;
  const stale = Number.isFinite(observed)&&Number.isFinite(nowMs)?nowMs-observed>STALE_MS:isStale(vehicle.latest_ping, nowMs);
  return {
    ...vehicle,
    stale,
    status: stale ? 'offline' : vehicle.status,
    eta: stale ? null : straightLineEta(vehicle),
  };
}
