#!/usr/bin/env node
/**
 * Operator token minter for live fleets. Explicit operator invocation only, with
 * the fleet JWT_SECRET in the environment. Never commit or log the secret, and
 * never commit generated tokens.
 *
 *   JWT_SECRET=... node tools/mint-token.mjs dispatcher <fleet_id> [ttlSeconds<=3600]
 *   JWT_SECRET=... node tools/mint-token.mjs crew <fleet_id> <vehicle_id> [ttlSeconds<=900]
 *   JWT_SECRET=... node tools/mint-token.mjs bridge <fleet_id> [ttlSeconds<=3600]
 */
import { createHmac } from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const [role, fleetId, third, fourth] = process.argv.slice(2);
const secret = process.env.JWT_SECRET;
if (!secret || Buffer.byteLength(secret) < 32) { console.error('JWT_SECRET (>=32 bytes) required in environment'); process.exit(1); }
if (!['dispatcher', 'crew', 'bridge'].includes(role ?? '') || !fleetId || !/^[a-zA-Z0-9_-]{1,80}$/.test(fleetId) || fleetId.toLowerCase().startsWith('demo')) {
  console.error('Usage: mint-token.mjs dispatcher|bridge <fleet_id> [ttl] | crew <fleet_id> <vehicle_id> [ttl]'); process.exit(1);
}
let vehicleId, ttlRaw;
if (role === 'crew') { vehicleId = third; ttlRaw = fourth; if (!vehicleId || !/^[a-zA-Z0-9_-]{1,80}$/.test(vehicleId)) { console.error('crew requires a vehicle id'); process.exit(1); } }
else ttlRaw = third;
const max = role === 'crew' ? 900 : 3600;
const ttl = ttlRaw === undefined ? max : Number(ttlRaw);
if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > max) { console.error(`ttl must be 1..${max} seconds for ${role}`); process.exit(1); }
const iat = Math.floor(Date.now() / 1000);
const claims = { sub: `${role}-operator`, fleet_id: fleetId, role, ...(vehicleId ? { vehicle_id: vehicleId } : {}), iss: 'ambulance-fleet', aud: 'fleet-api', iat, exp: iat + ttl };
const data = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`;
const sig = createHmac('sha256', secret).update(data).digest();
console.log(`${data}.${b64(sig)}`);
console.error(`issued ${role} token for fleet ${fleetId}${vehicleId ? ` vehicle ${vehicleId}` : ''}, expires ${new Date((iat + ttl) * 1000).toISOString()}`);
