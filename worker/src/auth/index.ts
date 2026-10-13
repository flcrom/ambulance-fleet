/** Clean implementation; no upstream source or runtime dependencies. */
export type Role = 'dispatcher' | 'crew' | 'bridge';
export type Claims = { sub: string; fleet_id: string; role: Role; vehicle_id?: string; exp: number };
export type AuthEnv = { JWT_SECRET?: string; LIVE_ENABLED?: string };
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterSeconds?: number) {
    super(message); this.name = 'ApiError';
    if (retryAfterSeconds !== undefined && (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1)) throw new Error('Invalid retry delay');
  }
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MAX_TOKEN_BYTES = 4096;
const MAX_TTL_SECONDS = 3600;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const authError = () => new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
function configuredSecret(secret: string | undefined): string {
  // Length is an operational minimum, not a randomness test.
  if (!secret || encoder.encode(secret).byteLength < 32) {
    throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Live API unavailable');
  }
  return secret;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw authError();
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }
function claimsFrom(value: unknown): Omit<Claims, 'exp'> {
  const c = object(value);
  if (!id(c.sub) || !id(c.fleet_id) || c.fleet_id.toLowerCase() === 'demo' ||
      (typeof c.role !== 'string' || !['dispatcher', 'crew', 'bridge'].includes(c.role)) ||
      (c.vehicle_id !== undefined && !id(c.vehicle_id)) ||
      (c.role === 'crew' && !id(c.vehicle_id))) throw authError();
  return { sub: c.sub, fleet_id: c.fleet_id, role: c.role as Role,
    ...(typeof c.vehicle_id === 'string' ? { vehicle_id: c.vehicle_id } : {}) };
}
function encode64(bytes: Uint8Array): string {
  let str = ''; for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function decode64(str: string): Uint8Array {
  if (!str || !/^[A-Za-z0-9_-]+$/.test(str) || str.length % 4 === 1) throw authError();
  const binary = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  if (encode64(bytes) !== str) throw authError();
  return bytes;
}
function json64(value: unknown): string { return encode64(encoder.encode(JSON.stringify(value))); }
async function key(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}
export async function issueToken(claims: Omit<Claims, 'exp'>, secret: string, options: { nowMs?: number; ttlSeconds?: number } = {}): Promise<string> {
  configuredSecret(secret);
  const clean = claimsFrom(claims);
  const ttl = options.ttlSeconds ?? 300;
  const iat = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(iat) || iat < 0 || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > (clean.role === 'crew' ? 900 : MAX_TTL_SECONDS)) {
    throw new ApiError(400, 'INVALID_TOKEN_OPTIONS', 'Token lifetime invalid (crew max 900s; other roles max 3600s)');
  }
  const data = `${json64({ alg: 'HS256', typ: 'JWT' })}.${json64({ ...clean, iss: 'ambulance-fleet', aud: 'fleet-api', iat, exp: iat + ttl })}`;
  const signature = await crypto.subtle.sign('HMAC', await key(secret, ['sign']), encoder.encode(data));
  return `${data}.${encode64(new Uint8Array(signature))}`;
}
export async function verifyToken(token: string, secret: string, nowMs = Date.now()): Promise<Claims> {
  configuredSecret(secret);
  try {
    if (token.length > MAX_TOKEN_BYTES) throw authError();
    const parts = token.split('.'); if (parts.length !== 3) throw authError();
    const [h, p, s] = parts;
    const header = object(JSON.parse(decoder.decode(decode64(h))));
    // No key URLs, key IDs, critical extensions, compression or algorithm negotiation.
    if (header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT') ||
        Object.keys(header).some(k => !['alg', 'typ'].includes(k))) throw authError();
    const signature = decode64(s); if (signature.length !== 32) throw authError();
    if (!await crypto.subtle.verify('HMAC', await key(secret, ['verify']), new Uint8Array(signature).buffer, encoder.encode(`${h}.${p}`))) throw authError();
    const payload = object(JSON.parse(decoder.decode(decode64(p))));
    const now = Math.floor(nowMs / 1000);
    if (!Number.isSafeInteger(now) || now < 0 || payload.iss !== 'ambulance-fleet' || payload.aud !== 'fleet-api' ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) throw authError();
    const iat = payload.iat as number, exp = payload.exp as number;
    if (iat < 0 || iat > now || exp <= now || exp <= iat || exp - iat > MAX_TTL_SECONDS) throw authError();
    if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || (payload.nbf as number) > now)) throw authError();
    const clean = claimsFrom(payload);
    if (clean.role === 'crew' && exp - iat > 900) throw authError();
    return { ...clean, exp };
  } catch { throw authError(); }
}
export function extractToken(request: Request): string {
  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (/^(token|access_token|auth|authorization|jwt|fleet-token)$/i.test(name)) throw authError();
  }
  const authorization = request.headers.get('Authorization');
  const protocols = request.headers.get('Sec-WebSocket-Protocol');
  const offered = protocols?.split(',').map(v => v.trim()) ?? [];
  const tokens = offered.filter(v => v.startsWith('fleet-token.'));
  if (tokens.length) {
    if (authorization || tokens.length !== 1 || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw authError();
    return tokens[0].slice('fleet-token.'.length);
  }
  if (!authorization || !/^Bearer [A-Za-z0-9_.-]+$/i.test(authorization)) throw authError();
  return authorization.slice(7);
}
export async function authorize(request: Request, env: AuthEnv): Promise<Claims> {
  if (env.LIVE_ENABLED !== 'true') throw new ApiError(503, 'LIVE_DISABLED', 'Live API unavailable');
  const secret = configuredSecret(env.JWT_SECRET);
  return verifyToken(extractToken(request), secret);
}
export function requireRole(claims: Claims, ...roles: Role[]): void {
  if (!roles.includes(claims.role)) throw new ApiError(403, 'FORBIDDEN', 'Operation not permitted');
}
export function requireVehicleAccess(claims: Claims, vehicleId: string): void {
  if (claims.role === 'crew' && claims.vehicle_id !== vehicleId) throw new ApiError(403, 'VEHICLE_FORBIDDEN', 'Operation not permitted');
}
export function requireFleet(claims: Claims, fleetId: string): void {
  if (fleetId === 'demo' || claims.fleet_id !== fleetId) throw new ApiError(403, 'FLEET_FORBIDDEN', 'Operation not permitted');
}
/** Apply before accepting a browser mutation or WebSocket. Do not trust forwarded origin headers. */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin) throw new ApiError(403, 'ORIGIN_FORBIDDEN', 'Origin not permitted');
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && origin === null) {
    throw new ApiError(403, 'ORIGIN_REQUIRED', 'WebSocket origin required');
  }
}
export * from './validation.js';
export * from './rate-limit.js';
/** Source claim alone is not trusted. Only provisioning assigns bridge service identity. */
export function requireRegistrationAccess(claims: Claims, source: 'device' | 'synthetic' | 'stand_in'): void {
  if (claims.role === 'dispatcher' || (claims.role === 'bridge' && source === 'stand_in')) return;
  throw new ApiError(403, 'FORBIDDEN', 'Operation not permitted');
}
/** Timeout fallback only. Persist exp and also recheck it on each DO socket broadcast. */
export function closeWebSocketAtExpiry(
  socket: { close(code?: number, reason?: string): void }, claims: Pick<Claims, 'exp'>,
  options: { nowMs?: number; schedule?: (callback: () => void, delayMs: number) => unknown; cancel?: (handle: unknown) => void } = {},
): () => void {
  const now = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(claims.exp) || claims.exp < 0 || !Number.isFinite(now)) throw new Error('Invalid socket expiry');
  const delay = claims.exp * 1000 - now;
  if (!Number.isSafeInteger(claims.exp * 1000) || delay > MAX_TTL_SECONDS * 1000) throw new Error('Socket expiry too far in future');
  const close = () => socket.close(1008, 'Authentication expired');
  if (delay <= 0) { close(); return () => {}; }
  const schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const handle = schedule(close, delay);
  return () => cancel(handle);
}
