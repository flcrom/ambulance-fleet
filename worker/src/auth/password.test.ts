import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, passwordAcceptable, PASSWORD_ITERATIONS, DUMMY_RECORD } from './password';
import { extractToken } from './index';

const GOOD = 'aB3$xY9mQ2vL8pR4nK6wT1zS'; // 24-char generated-style secret

describe('password records', () => {
  it('roundtrips a correct password', async () => {
    const record = await hashPassword(GOOD);
    expect(record.startsWith(`v1$${PASSWORD_ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword(GOOD, record)).toBe(true);
  });
  it('rejects a wrong password', async () => {
    const record = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD.slice(0, -1) + 'X', record)).toBe(false);
  });
  it('rejects malformed and tampered records', async () => {
    const record = await hashPassword(GOOD);
    const [v, iter, salt, hash] = record.split('$');
    expect(await verifyPassword(GOOD, 'garbage')).toBe(false);
    expect(await verifyPassword(GOOD, undefined)).toBe(false);
    expect(await verifyPassword(GOOD, `v2$${iter}$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword(GOOD, `v1$999$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword(GOOD, `v1$9999999$${salt}$${hash}`)).toBe(false);
    expect(await verifyPassword(GOOD, `v1$${iter}$!!!$${hash}`)).toBe(false);
    expect(await verifyPassword(GOOD, `v1$${iter}$${salt}$${hash.slice(0, -2)}`)).toBe(false);
  });
  it('rejects oversized passwords before doing work', async () => {
    const record = await hashPassword(GOOD);
    expect(await verifyPassword('x'.repeat(5000), record)).toBe(false);
  });
  it('enforces the password policy', () => {
    expect(passwordAcceptable(GOOD)).toBe(true);
    expect(passwordAcceptable('short')).toBe(false);
    expect(passwordAcceptable(123)).toBe(false);
    expect(passwordAcceptable('x'.repeat(200))).toBe(false);
  });
  it('produces unique salts', async () => {
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
  });
});

describe('ops session cookie extraction', () => {
  const JWT = 'aaa.bbb.ccc';
  it('reads the ops cookie', () => {
    const request = new Request('https://siren.flcrom.dev/api/fleet', { headers: { Cookie: `other=1; __Host-siren_ops=${JWT}; theme=dark` } });
    expect(extractToken(request)).toBe(JWT);
  });
  it('rejects cookie combined with an Authorization header', () => {
    const request = new Request('https://siren.flcrom.dev/api/fleet', { headers: { Cookie: `__Host-siren_ops=${JWT}`, Authorization: `Bearer ${JWT}` } });
    expect(() => extractToken(request)).toThrow();
  });
  it('still prefers a websocket protocol token', () => {
    const request = new Request('https://siren.flcrom.dev/api/events', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `fleet.v1, fleet-token.${JWT}` } });
    expect(extractToken(request)).toBe(JWT);
  });
  it('ignores a cookie when a websocket protocol token is present', () => {
    const request = new Request('https://siren.flcrom.dev/api/events', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `fleet.v1, fleet-token.${JWT}`, Cookie: '__Host-siren_ops=zzz.yyy.xxx' } });
    expect(extractToken(request)).toBe(JWT);
  });
  it('throws without any credential', () => {
    expect(() => extractToken(new Request('https://siren.flcrom.dev/api/fleet'))).toThrow();
  });
});

describe('dummy record', () => {
  it('runs the full PBKDF2 path and never verifies', async () => {
    const started = Date.now();
    await expect(verifyPassword('wrong-password-1234', DUMMY_RECORD)).resolves.toBe(false);
    const dummyMs = Date.now() - started;
    const record = await hashPassword('correct-horse-battery');
    const t2 = Date.now();
    await expect(verifyPassword('wrong-password-1234', record)).resolves.toBe(false);
    const realMs = Date.now() - t2;
    // Same code path: the no-record case must not short-circuit before PBKDF2.
    expect(dummyMs).toBeGreaterThan(realMs / 4);
  });
});
