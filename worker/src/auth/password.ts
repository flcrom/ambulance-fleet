/**
 * Owner password records for the private ops login: PBKDF2-SHA256 stored as
 * `v1$iterations$salt$hash` (base64url). The plaintext password is never stored
 * or logged. Iterations are tuned to the Workers CPU budget (see tests); the
 * generated owner password is high-entropy, so the record only needs to resist
 * casual disclosure of DO storage, and online guessing is handled by the login
 * rate limit and temporary lockout in store.ts.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const PASSWORD_ITERATIONS = 25000;
export const PASSWORD_MIN_CHARS = 16;
export const PASSWORD_MAX_BYTES = 128;
/**
 * Valid-format record with a fixed salt and an all-zero derived key. Login
 * verifies against this when a fleet has no owner password yet (or the fleet
 * does not exist), so the failed-login timing does not reveal which case it is.
 */
export const DUMMY_RECORD = 'v1$25000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function b64(bytes: Uint8Array): string {
  let str = ''; for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function unb64(str: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(str) || str.length % 4 === 1) return null;
  try {
    const binary = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch { return null; }
}
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}
export function passwordAcceptable(password: unknown): password is string {
  if (typeof password !== 'string') return false;
  let bytes = 0; try { bytes = encoder.encode(password).byteLength; decoder.decode(encoder.encode(password)); } catch { return false; }
  return password.length >= PASSWORD_MIN_CHARS && bytes <= PASSWORD_MAX_BYTES;
}
export async function hashPassword(password: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  if (!passwordAcceptable(password)) throw new Error('Password does not meet policy');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `v1$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}
export async function verifyPassword(password: unknown, record: string | undefined): Promise<boolean> {
  if (typeof password !== 'string' || typeof record !== 'string') return false;
  if (encoder.encode(password).byteLength > PASSWORD_MAX_BYTES) return false;
  const parts = record.split('$');
  if (parts.length !== 4 || parts[0] !== 'v1') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1000 || iterations > 600000) return false;
  const salt = unb64(parts[2]); const expected = unb64(parts[3]);
  if (!salt || salt.length !== 16 || !expected || expected.length !== 32) return false;
  let actual: Uint8Array;
  try { actual = await pbkdf2(password, salt, iterations); } catch { return false; }
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
