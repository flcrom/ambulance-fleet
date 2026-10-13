import { parseIsoUtc } from './validate';
import type { Ping, PingInput } from './types';

export const SKEW_ALLOWANCE_MS = 5_000;

/**
 * Comparison time: recorded_at clamped to received_at + 5 s, so a device clock running up to 60 s
 * ahead cannot pin an old position as latest and block genuine later pings.
 */
function effectiveMs(p: { recorded_at: string; received_at?: string }): number {
  const t = parseIsoUtc(p.recorded_at);
  const r = p.received_at === undefined ? NaN : parseIsoUtc(p.received_at);
  return Number.isNaN(t) || Number.isNaN(r) ? t : Math.min(t, r + SKEW_ALLOWANCE_MS);
}

/** True only if `incoming` is strictly newer (skew-clamped recorded_at) than `latest`. Equal never advances. */
export function isNewer(latest: Ping | null, incoming: { recorded_at: string; received_at?: string }): boolean {
  if (!latest) return true;
  const a = effectiveMs(incoming), b = effectiveMs(latest);
  if (Number.isNaN(a)) return false;
  if (Number.isNaN(b)) return true;
  if (a !== b) return a > b;
  // Clamped times tie (e.g. several future-dated events): the later raw recorded_at wins, so order cannot matter.
  return parseIsoUtc(incoming.recorded_at) > parseIsoUtc(latest.recorded_at);
}

export type IngestResult =
  | { kind: 'duplicate'; latest: Ping | null }
  | { kind: 'accepted'; ping: Ping; latest: Ping | null; advanced: boolean };

/**
 * Decide what a validated ping does. Duplicate event_id (fleet-scoped `seen`) changes nothing.
 * Otherwise the ping is accepted into history; `latest` moves only if recorded_at is newer,
 * so reordered events never rewind the map. Pure: caller persists and adds event_id to `seen`.
 */
export function ingestPing(
  latest: Ping | null, seen: { has(id: string): boolean }, input: PingInput, receivedAtIso: string,
): IngestResult {
  const id = typeof input.event_id === 'string' ? input.event_id.toLowerCase() : input.event_id;
  if (seen.has(input.event_id) || seen.has(id)) return { kind: 'duplicate', latest };
  const ping: Ping = { ...input, event_id: id, telemetry_time:input.telemetry_time??'receipt', received_at: receivedAtIso };
  const advanced = isNewer(latest, ping);
  return { kind: 'accepted', ping, latest: advanced ? ping : latest, advanced };
}
