import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as R from './index';
import type { Ping, Vehicle, Alert } from './index';

const NOW = Date.parse('2026-10-13T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = (o: Record<string, unknown> = {}) => ({ event_id: uuid(1), vehicle_id: 'v1', recorded_at: iso(NOW), lat: 42.36, lon: -71.06, speed_kph: 30, heading: 90, telemetry_time:'device' as const, ...o });
const ping = (o: Partial<Ping> = {}): Ping => ({ ...(input() as any), received_at: iso(NOW), ...o });
const veh = (o: Partial<Vehicle> = {}): Vehicle => ({ id: 'v1', callsign: 'A1', type: 'ALS', status: 'en_route', destination: { label: 'H', lat: 42.37, lon: -71.06 }, latest_ping: ping(), stale: false, eta: null, ...o });

describe('validatePing', () => {
  it('accepts valid and boundaries', () => {
    expect(R.validatePing(input(), NOW).vehicle_id).toBe('v1');
    R.validatePing(input({ lat: 90, lon: -180, speed_kph: 200, heading: 0 }), NOW);
    R.validatePing(input({ recorded_at: iso(NOW + 60_000) }), NOW);
    R.validatePing(input({ recorded_at: iso(NOW - 86_400_000) }), NOW);
  });
  it.each([
    ['null', null], ['array', []], ['short id', input({ event_id: 'abc' })], ['non-uuid 36', input({ event_id: 'x'.repeat(36) })],
    ['empty vehicle', input({ vehicle_id: '' })], ['lat', input({ lat: 90.1 })], ['lon', input({ lon: 180.1 })],
    ['NaN', input({ lat: NaN })], ['Infinity', input({ lon: Infinity })], ['string lat', input({ lat: '1' })],
    ['speed>200', input({ speed_kph: 200.1 })], ['neg speed', input({ speed_kph: -1 })],
    ['heading 360', input({ heading: 360 })], ['heading neg', input({ heading: -0.1 })],
    ['future', input({ recorded_at: iso(NOW + 60_001) })], ['old', input({ recorded_at: iso(NOW - 86_400_001) })],
    ['not iso', input({ recorded_at: 'yesterday' })], ['offset tz', input({ recorded_at: '2026-10-13T00:00:00+05:30' })],
    ['feb 30', input({ recorded_at: '2026-02-30T00:00:00Z' })], ['bad telemetry_time', input({ telemetry_time: 'x' })],
  ])('rejects %s', (_n, v) => expect(() => R.validatePing(v, NOW)).toThrow());
  it('keeps valid telemetry_time and drops unknown fields', () => {
    const o = R.validatePing(input({ telemetry_time: 'receipt', extra: 1 }), NOW) as any;
    expect(o.telemetry_time).toBe('receipt'); expect(o.extra).toBeUndefined();
  });
  it('property: never throws a non-Error on arbitrary input', () => {
    fc.assert(fc.property(fc.anything(), v => { try { R.validatePing(v, NOW); } catch (e) { return e instanceof Error; } return true; }));
  });
  it('property: finite in-range numbers pass', () => {
    fc.assert(fc.property(fc.double({ min: -90, max: 90, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }),
      fc.double({ min: 0, max: 200, noNaN: true }), fc.double({ min: 0, max: 359.999, noNaN: true }),
      (lat, lon, speed_kph, heading) => { R.validatePing(input({ lat, lon, speed_kph, heading }), NOW); }));
  });
});

describe('distanceMeters', () => {
  it('zero for same point', () => expect(R.distanceMeters({ lat: 1, lon: 2 }, { lat: 1, lon: 2 })).toBe(0));
  it('one degree latitude ~111.2 km', () => expect(R.distanceMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111195, -2));
  it('antimeridian: 179.999 to -179.999 is ~222 m, not ~40000 km', () => {
    const d = R.distanceMeters({ lat: 0, lon: 179.999 }, { lat: 0, lon: -179.999 });
    expect(d).toBeGreaterThan(200); expect(d).toBeLessThan(240);
  });
  it('antimeridian equals unwrapped equivalent', () => {
    expect(R.distanceMeters({ lat: 10, lon: 180 }, { lat: 10, lon: -180 })).toBeLessThan(1e-6);
  });
  it('poles: all longitudes coincide', () => expect(R.distanceMeters({ lat: 90, lon: 0 }, { lat: 90, lon: 123 })).toBeLessThan(1e-3));
  const pt = fc.record({ lat: fc.double({ min: -90, max: 90, noNaN: true }), lon: fc.double({ min: -180, max: 180, noNaN: true }) });
  it('property: symmetric, nonnegative, bounded by half circumference', () => {
    fc.assert(fc.property(pt, pt, (a, b) => {
      const d = R.distanceMeters(a, b);
      return d >= 0 && d <= 20_015_200 && Math.abs(d - R.distanceMeters(b, a)) < 1e-6;
    }));
  });
  it('property: triangle inequality', () => {
    fc.assert(fc.property(pt, pt, pt, (a, b, c) => R.distanceMeters(a, c) <= R.distanceMeters(a, b) + R.distanceMeters(b, c) + 1e-3));
  });
});

describe('stale / deriveVehicle', () => {
  it('fresh at exactly 30 s, stale after', () => {
    expect(R.isStale(ping(), NOW + 30_000)).toBe(false);
    expect(R.isStale(ping(), NOW + 30_001)).toBe(true);
  });
  it('no ping is stale', () => expect(R.isStale(null, NOW)).toBe(true));
  it('replayed old event with fresh receipt is stale', () =>
    expect(R.isStale(ping({ recorded_at: iso(NOW - 120_000), received_at: iso(NOW) }), NOW)).toBe(true));
  it('future device clock does not extend freshness', () =>
    expect(R.isStale(ping({ recorded_at: iso(NOW + 50_000), received_at: iso(NOW) }), NOW + 31_000)).toBe(true));
  it('garbage timestamp is stale', () => expect(R.isStale(ping({ received_at: 'x' }), NOW)).toBe(true));
  it('fresh vehicle keeps status, has eta', () => {
    const d = R.deriveVehicle(veh(), NOW);
    expect(d.stale).toBe(false); expect(d.status).toBe('en_route');
    expect(d.eta).toEqual({ minutes: expect.any(Number), method: 'straight_line', approximate: true });
  });
  it('stale vehicle is offline, eta null, input not mutated', () => {
    const v = veh(); const d = R.deriveVehicle(v, NOW + 31_000);
    expect(d.stale).toBe(true); expect(d.status).toBe('offline'); expect(d.eta).toBeNull();
    expect(v.status).toBe('en_route');
    expect(R.deriveVehicle({ ...v, status: d.status === 'offline' ? v.status : 'x' as any }, NOW).status).toBe('en_route'); // reconnect
  });
  it('preserves source flag', () => expect(R.deriveVehicle(veh({ source: 'stand_in' }), NOW).source).toBe('stand_in'));
  it('no ping: offline, no eta', () => {
    const d = R.deriveVehicle(veh({ latest_ping: null }), NOW);
    expect(d.stale).toBe(true); expect(d.eta).toBeNull(); expect(d.status).toBe('offline');
  });
});

describe('ETA', () => {
  const at = (speed_kph: number) => veh({ latest_ping: ping({ lat: 0, lon: 0, speed_kph }), destination: { label: 'H', lat: 0.1, lon: 0 } });
  it('~11.1 km at 60 kph is 12 min (rounded up)', () => expect(R.deriveVehicle(at(60), NOW).eta?.minutes).toBe(12));
  it('zero speed -> null, no division blow-up', () => expect(R.deriveVehicle(at(0), NOW).eta).toBeNull());
  it('4.99 kph -> null; 5 kph -> number', () => {
    expect(R.deriveVehicle(at(4.99), NOW).eta).toBeNull();
    expect(Number.isFinite(R.deriveVehicle(at(5), NOW).eta!.minutes)).toBe(true);
  });
  it('no destination -> null', () => expect(R.deriveVehicle(veh({ destination: null }), NOW).eta).toBeNull());
  it('antimeridian crossing gives small eta', () => {
    const v = veh({ latest_ping: ping({ lat: 0, lon: 179.99, speed_kph: 60 }), destination: { label: 'H', lat: 0, lon: -179.99 } });
    expect(R.deriveVehicle(v, NOW).eta!.minutes).toBeLessThan(5);
  });
  it('property: finite, nonnegative integer, always labelled approximate', () => {
    fc.assert(fc.property(fc.double({ min: -90, max: 90, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }),
      fc.double({ min: 0, max: 200, noNaN: true }), (lat, lon, speed_kph) => {
        const e = R.straightLineEta({ latest_ping: ping({ lat, lon, speed_kph }), destination: { label: 'x', lat: 0, lon: 0 } });
        return e === null ? speed_kph < 5 : Number.isInteger(e.minutes) && e.minutes >= 0 && e.approximate === true && e.method === 'straight_line';
      }));
  });
});

describe('arrival geofence', () => {
  const dest = { label: 'H', lat: 0, lon: 0 };
  const at = (lat: number, lon: number) => veh({ destination: dest, latest_ping: ping({ lat, lon }) });
  it('inside 150 m', () => expect(R.arrival(at(0.001, 0))).toBe(true)); // ~111 m
  it('outside 150 m', () => expect(R.arrival(at(0.002, 0))).toBe(false)); // ~222 m
  it('boundary: 149.9 in, 150.5 out', () => {
    const m = 1 / 111195;
    expect(R.arrival(at(149.9 * m, 0))).toBe(true);
    expect(R.arrival(at(150.5 * m, 0))).toBe(false);
  });
  it('no destination / no ping -> false', () => {
    expect(R.arrival(veh({ destination: null }))).toBe(false);
    expect(R.arrival(veh({ latest_ping: null }))).toBe(false);
  });
  it('works across antimeridian', () => {
    expect(R.arrival(veh({ destination: { label: 'H', lat: 0, lon: 180 }, latest_ping: ping({ lat: 0, lon: -179.9995 }) }))).toBe(true);
  });
  it('does not alter status', () => { const v = at(0, 0); R.arrival(v); expect(v.status).toBe('en_route'); });
});

describe('ingestPing', () => {
  const seen = new Set<string>();
  it('first ping advances', () => {
    const r = R.ingestPing(null, seen, R.validatePing(input(), NOW), iso(NOW));
    expect(r).toMatchObject({ kind: 'accepted', advanced: true });
  });
  it('duplicate event_id changes nothing', () => {
    const latest = ping();
    const r = R.ingestPing(latest, new Set([uuid(1)]), R.validatePing(input({ recorded_at: iso(NOW + 5000) }), NOW), iso(NOW));
    expect(r).toEqual({ kind: 'duplicate', latest });
  });
  it('older ping accepted but latest not rewound', () => {
    const latest = ping({ recorded_at: iso(NOW) });
    const r = R.ingestPing(latest, seen, R.validatePing(input({ event_id: uuid(2), recorded_at: iso(NOW - 5000) }), NOW), iso(NOW + 1000));
    expect(r).toMatchObject({ kind: 'accepted', advanced: false }); expect(r.latest).toBe(latest);
  });
  it('equal recorded_at does not advance', () => {
    const latest = ping();
    expect(R.ingestPing(latest, seen, R.validatePing(input({ event_id: uuid(3) }), NOW), iso(NOW)).latest).toBe(latest);
  });
  it('property: any arrival order yields latest == max recorded_at; replays never change it', () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 3_000_000 }), { minLength: 1, maxLength: 20 }), fc.nat(), (offs, seed) => {
      const evs = offs.map((o, i) => input({ event_id: uuid(i + 10), recorded_at: iso(NOW - 3_600_000 + o) }));
      const order = [...evs].sort((a, b) => ((a.event_id.charCodeAt(35) * (seed + 7)) % 13) - ((b.event_id.charCodeAt(35) * (seed + 7)) % 13) || a.event_id.localeCompare(b.event_id));
      let latest: Ping | null = null; const s = new Set<string>();
      for (const e of [...order, ...order]) {
        const r = R.ingestPing(latest, s, R.validatePing(e, NOW), iso(NOW)); latest = r.latest;
        if (r.kind === 'accepted') s.add(e.event_id);
      }
      const max = Math.max(...offs);
      return latest!.recorded_at === iso(NOW - 3_600_000 + max);
    }));
  });
  it('property: latest recorded_at never decreases', () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 1e6 }), { minLength: 1, maxLength: 30 }), offs => {
      let latest: Ping | null = null; let prev = -Infinity;
      offs.forEach((o, i) => {
        latest = R.ingestPing(latest, new Set(), R.validatePing(input({ event_id: uuid(i + 100), recorded_at: iso(NOW - 3_000_000 + o) }), NOW), iso(NOW)).latest;
        const t = Date.parse(latest!.recorded_at); if (t < prev) throw new Error('rewind'); prev = t;
      });
    }));
  });
});

describe('hardening', () => {
  it('accepts RFC 9562 v8 UUID and lowercases event_id', () => {
    expect(R.validatePing(input({ event_id: '0190F3A2-7B1C-8D4E-9A5B-1234567890AB' }), NOW).event_id).toBe('0190f3a2-7b1c-8d4e-9a5b-1234567890ab');
  });
  it('dedupe is case-insensitive', () => {
    const r = R.ingestPing(null, new Set([uuid(1)]), input({ event_id: uuid(1).toUpperCase().replace(/^0+/, m => m) }) as any, iso(NOW));
    expect(r.kind).toBe('duplicate');
    const r2 = R.ingestPing(null, new Set(), input({ event_id: 'ABCDEF00-0000-4000-8000-000000000001' }) as any, iso(NOW));
    expect(r2.kind === 'accepted' && r2.ping.event_id).toBe('abcdef00-0000-4000-8000-000000000001');
  });
  it('NaN now fails safe', () => {
    expect(R.isStale(ping(), NaN)).toBe(true);
    expect(() => R.validatePing(input(), NaN)).toThrow();
  });
  it('non-finite speed or coords give null eta; Infinity is not 0', () => {
    for (const o of [{ speed_kph: NaN }, { speed_kph: Infinity }, { lat: NaN }, { lon: Infinity }])
      expect(R.straightLineEta({ destination: { label: 'x', lat: 1, lon: 1 }, latest_ping: ping(o) })).toBeNull();
    expect(R.straightLineEta({ destination: { label: 'x', lat: NaN, lon: 1 }, latest_ping: ping() })).toBeNull();
  });
  it('future-dated ping (+59 s) does not block a genuine later ping', () => {
    const fut = R.ingestPing(null, new Set(), input({ recorded_at: iso(NOW + 59_000) }) as any, iso(NOW)) as any;
    const real = R.ingestPing(fut.latest, new Set(), input({ event_id: uuid(5), recorded_at: iso(NOW + 10_000) }) as any, iso(NOW + 10_000)) as any;
    expect(real.advanced).toBe(true);
  });
  it('small skew (<=5 s) still advances normally', () => {
    const l = ping();
    expect(R.isNewer(l, { recorded_at: iso(NOW + 1), received_at: iso(NOW) })).toBe(true);
  });
  it('malformed timestamp acked stale alert does not refire', () => {
    const v = veh({ latest_ping: ping({ received_at: 'garbage' }) });
    const [a] = R.evaluateAlerts(v, null, [], NOW, () => 'q');
    expect(R.evaluateAlerts(v, null, [R.acknowledge(a, NOW)], NOW + 1000, () => 'r')).toHaveLength(0);
  });
  it('no arrival alert from a stale ping', () => {
    const v = veh({ destination: { label: 'H', lat: 0, lon: 0 }, latest_ping: ping({ lat: 0, lon: 0 }) });
    expect(R.evaluateAlerts(v, null, [], NOW + 60_000, () => 'z').map(a => a.kind)).toEqual(['stale']);
  });
});

describe('alerts', () => {
  let n = 0; const id = () => `a${++n}`;
  const stale = veh();
  it('stale alert created once, not duplicated while open', () => {
    const a = R.evaluateAlerts(stale, null, [], NOW + 31_000, id);
    expect(a.filter(x => x.kind === 'stale')).toHaveLength(1);
    expect(R.evaluateAlerts(stale, null, a, NOW + 60_000, id)).toHaveLength(0);
  });
  it('no stale alert for fresh vehicle', () => expect(R.evaluateAlerts(stale, null, [], NOW + 5000, id)).toHaveLength(0));
  it('acked stale alert is not recreated in same episode', () => {
    const a = R.acknowledge(R.evaluateAlerts(stale, null, [], NOW + 31_000, id)[0], NOW + 32_000);
    expect(R.evaluateAlerts(stale, null, [a], NOW + 90_000, id)).toHaveLength(0);
  });
  it('new episode after recovery re-alerts', () => {
    const a = R.acknowledge(R.evaluateAlerts(stale, null, [], NOW + 31_000, id)[0], NOW + 32_000);
    const later = veh({ latest_ping: ping({ recorded_at: iso(NOW + 100_000), received_at: iso(NOW + 100_000) }) });
    expect(R.evaluateAlerts(later, null, [a], NOW + 140_000, id).map(x => x.kind)).toEqual(['stale']);
  });
  it('never-pinged vehicle raises one stale alert, not repeated', () => {
    const a = R.evaluateAlerts(veh({ latest_ping: null }), null, [], NOW, id);
    expect(a).toHaveLength(1);
    expect(R.evaluateAlerts(veh({ latest_ping: null }), null, [R.acknowledge(a[0], NOW)], NOW + 1e6, id)).toHaveLength(0);
  });
  const near = veh({ destination: { label: 'H', lat: 0, lon: 0 }, latest_ping: ping({ lat: 0.0005, lon: 0 }) });
  const far = veh({ destination: { label: 'H', lat: 0, lon: 0 }, latest_ping: ping({ lat: 0.01, lon: 0 }) });
  it('arrival fires on entering geofence only', () => {
    const a = R.evaluateAlerts(near, far, [], NOW, id);
    expect(a.map(x => x.kind)).toEqual(['arrival']);
    expect(a[0].message).toMatch(/advisory/);
    expect(R.evaluateAlerts(near, near, [], NOW, id)).toHaveLength(0);
  });
  it('arrival not duplicated while open; re-entry after ack alerts again', () => {
    const [a] = R.evaluateAlerts(near, far, [], NOW, id);
    expect(R.evaluateAlerts(near, far, [a], NOW, id)).toHaveLength(0);
    expect(R.evaluateAlerts(near, far, [R.acknowledge(a, NOW)], NOW, id)).toHaveLength(1);
  });
  it('arrival on first ping (no previous) fires; alerts for other vehicles do not suppress', () => {
    const other: Alert = { id: 'z', vehicle_id: 'v9', kind: 'arrival', created_at: iso(NOW), message: '', acknowledged_at: null };
    expect(R.evaluateAlerts(near, null, [other], NOW, id)).toHaveLength(1);
  });
  it('acknowledge is idempotent and non-mutating', () => {
    const a: Alert = { id: 'x', vehicle_id: 'v1', kind: 'stale', created_at: iso(NOW), message: '', acknowledged_at: null };
    const b = R.acknowledge(a, NOW + 1000), c = R.acknowledge(b, NOW + 9000);
    expect(a.acknowledged_at).toBeNull(); expect(c.acknowledged_at).toBe(iso(NOW + 1000)); expect(c).toBe(b);
  });
  it('no clinical wording in messages', () => {
    const m = [...R.evaluateAlerts(stale, null, [], NOW + 31_000, id), ...R.evaluateAlerts(near, far, [], NOW, id)].map(a => a.message).join(' ');
    expect(m).not.toMatch(/patient|clinical|critical|diagnos|response time/i);
  });
});

describe('skew tie-break', () => {
  it('future-dated events received together converge to max recorded_at in any order', () => {
    const evs = [59, 20, 40].map((s, i) => input({ event_id: uuid(200 + i), recorded_at: iso(NOW + s * 1000) }) as any);
    for (const order of [evs, [...evs].reverse(), [evs[1], evs[2], evs[0]]]) {
      let l: Ping | null = null;
      for (const e of order) l = (R.ingestPing(l, new Set(), e, iso(NOW)) as any).latest;
      expect(l!.recorded_at).toBe(iso(NOW + 59_000));
    }
  });
});
