import type { PingInput } from './types';
export const MAX_FUTURE_MS = 60_000;
export const MAX_AGE_MS = 24 * 3600_000;
export const MAX_SPEED_KPH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Parse strict ISO-8601 UTC ("...Z"); returns NaN for anything else, including impossible dates. */
export function parseIsoUtc(s: unknown): number {
  if (typeof s !== 'string' || !ISO_UTC.test(s)) return NaN;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return NaN;
  // reject rollover such as Feb 30 / hour 24
  return new Date(t).toISOString().slice(0, 19) === s.slice(0, 19) ? t : NaN;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validatePing(value: unknown, nowMs: number = Date.now()): PingInput & {telemetry_time:'device'|'receipt'} {
  if (!Number.isFinite(nowMs)) throw new Error('invalid clock');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('ping must be an object');
  const v = value as Record<string, unknown>;
  if (typeof v.event_id !== 'string' || v.event_id.length !== 36 || !UUID.test(v.event_id)) throw new Error('event_id must be a UUID');
  if (typeof v.vehicle_id !== 'string' || v.vehicle_id.length === 0) throw new Error('vehicle_id required');
  const t = parseIsoUtc(v.recorded_at);
  if (Number.isNaN(t)) throw new Error('recorded_at must be ISO 8601 UTC');
  if (t > nowMs + MAX_FUTURE_MS) throw new Error('recorded_at is more than 60s in the future');
  if (t < nowMs - MAX_AGE_MS) throw new Error('recorded_at is more than 24h old');
  if (!num(v.lat) || v.lat < -90 || v.lat > 90) throw new Error('lat out of range');
  if (!num(v.lon) || v.lon < -180 || v.lon > 180) throw new Error('lon out of range');
  if (v.speed_kph !== null && (!num(v.speed_kph) || v.speed_kph < 0 || v.speed_kph > MAX_SPEED_KPH)) throw new Error('speed_kph out of range');
  if (v.heading !== null && (!num(v.heading) || v.heading < 0 || v.heading >= 360)) throw new Error('heading must satisfy 0 <= heading < 360');
  if (v.telemetry_time !== undefined && v.telemetry_time !== 'device' && v.telemetry_time !== 'receipt') throw new Error('telemetry_time must be device or receipt');
  return {
    telemetry_time: v.telemetry_time ?? 'receipt',
    event_id: v.event_id.toLowerCase(), vehicle_id: v.vehicle_id, recorded_at: v.telemetry_time === undefined ? new Date(nowMs).toISOString() : v.recorded_at as string,
    lat: v.lat, lon: v.lon, speed_kph: v.speed_kph, heading: v.heading,
  };
}
