import { ApiError } from './index.js';
const invalid = (message: string) => new ApiError(400, 'INVALID_INPUT', message);
export function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Object required');
  return value as Record<string, unknown>;
}
export function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some(k => !allowed.includes(k))) throw invalid('Unexpected field');
}
export function validateIdentifier(value: unknown, name = 'Identifier'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw invalid(`${name} invalid`);
  return value;
}
export function validateText(value: unknown, maxLength = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\p{C}\u2028\u2029]/u.test(value)) throw invalid('Text invalid');
  return value.trim();
}
export function validateFinite(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid('Number out of range');
  return value;
}
export function validateHistoryLimit(value: string | null): number {
  if (value === null) return 100;
  if (!/^[1-9][0-9]{0,2}$/.test(value)) throw invalid('History limit must be 1..500');
  const n = Number(value); if (n > 500) throw invalid('History limit must be 1..500');
  return n;
}
/** Bounds actual bytes even when Content-Length is absent or dishonest. */
export async function readJson(request: Request, maxBytes = 16384): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid body limit');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON required');
  if (request.headers.get('Content-Encoding') && request.headers.get('Content-Encoding') !== 'identity') throw new ApiError(415, 'UNSUPPORTED_ENCODING', 'Compressed bodies not accepted');
  const declared = request.headers.get('Content-Length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request too large');
  if (!request.body) throw invalid('JSON required');
  const reader = request.body.getReader();
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, 'BODY_TOO_LARGE', 'Request too large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { throw invalid('Malformed JSON'); }
}
export function apiErrorResponse(error: unknown): Response {
  const e = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_ERROR', 'Internal error');
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (e.status === 401) headers['WWW-Authenticate'] = 'Bearer realm="fleet-api"';
  if (e.status === 429) headers['Retry-After'] = String(e.retryAfterSeconds ?? 1);
  return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status,
    headers });
}
export type VehicleRegistration = { id: string; callsign: string; type: 'BLS' | 'ALS'; source: 'device' | 'synthetic' | 'stand_in' };
export function validateVehicleRegistration(value: unknown): VehicleRegistration {
  const v = assertRecord(value); rejectUnknownKeys(v, ['id', 'callsign', 'type', 'source']);
  if (v.type !== 'BLS' && v.type !== 'ALS') throw invalid('Vehicle type invalid');
  const source = v.source ?? 'device';
  if (source !== 'device' && source !== 'synthetic' && source !== 'stand_in') throw invalid('Vehicle source invalid');
  return { id: validateIdentifier(v.id), callsign: validateText(v.callsign, 80), type: v.type, source };
}
export type VehiclePatch = { status?: 'available' | 'en_route' | 'at_scene' | 'transporting' | 'at_hospital'; destination?: { label: string; lat: number; lon: number } | null };
export function validateVehiclePatch(value: unknown): VehiclePatch {
  const v = assertRecord(value); rejectUnknownKeys(v, ['status', 'destination']);
  if (Object.keys(v).length === 0) throw invalid('Patch cannot be empty');
  const result: VehiclePatch = {};
  if ('status' in v) {
    if (typeof v.status !== 'string' || !['available', 'en_route', 'at_scene', 'transporting', 'at_hospital'].includes(v.status)) throw invalid('Vehicle status invalid');
    result.status = v.status as VehiclePatch['status'];
  }
  if ('destination' in v) {
    if (v.destination === null) result.destination = null;
    else {
      const d = assertRecord(v.destination); rejectUnknownKeys(d, ['label', 'lat', 'lon']);
      result.destination = { label: validateText(d.label), lat: validateFinite(d.lat, -90, 90), lon: validateFinite(d.lon, -180, 180) };
    }
  }
  return result;
}
