import { describe, expect, it } from 'vitest';
import { advance, initialState, positionOnLeg, MAX_OPEN_INCIDENTS } from './sim';
import type { Router, SimState } from './sim';
import { distanceMeters } from '../rules/geo';

const straight: Router = async (from, to) => ({ points: [{ ...from }, { lat: to.lat, lon: to.lon }], total_m: distanceMeters(from, to) });

async function run(state: SimState, fromMs: number, toMs: number, stepMs = 5000, router: Router = straight) {
  const events = [];
  for (let t = fromMs; t <= toMs; t += stepMs)
    // Snapshot fields at event time; the engine keeps mutating shared objects.
    for (const e of await advance(state, t, router))
      events.push({ type: e.type, incidentId: 'incident' in e ? e.incident.id : null, unitId: 'unit' in e ? e.unit.id : null, incident: 'incident' in e ? e.incident : undefined, unit: 'unit' in e ? e.unit : undefined });
  return events;
}

describe('dispatch simulation', () => {
  it('initialises eight available units at stations', () => {
    const s = initialState(1_000_000);
    expect(s.units).toHaveLength(8);
    expect(s.units.every(u => u.status === 'available' && u.leg === null)).toBe(true);
    expect(new Set(s.units.map(u => u.id)).size).toBe(8);
  });

  it('generates a call at the scheduled time, not before', async () => {
    const s = initialState(1_000_000);
    expect(await run(s, 1_000_000, 1_019_000)).toHaveLength(0);
    expect(s.incidents).toHaveLength(0);
    const events = await run(s, 1_020_000, 1_025_000);
    expect(events.some(e => e.type === 'call')).toBe(true);
    expect(s.incidents).toHaveLength(1);
    expect(['open','assigned']).toContain(s.incidents[0].status);
  });

  it('dispatches the nearest available unit and runs the full call lifecycle', async () => {
    const s = initialState(1_000_000);
    const events = await run(s, 1_000_000, 1_000_000 + 90 * 60 * 1000);
    for (const type of ['call', 'dispatched', 'arrived_scene', 'transporting', 'arrived_hospital', 'unit_available'])
      expect(events.some(e => e.type === type), `missing ${type}`).toBe(true);
    const dispatched = events.filter(e => e.type === 'dispatched');
    // A unit never runs two calls at once: its dispatches never overlap.
    for (const e of events) if (e.type === 'dispatched') expect(e.incidentId).not.toBeNull();
    const byUnit = new Map<string, string[]>();
    for (const e of dispatched) byUnit.set(e.unitId!, [...(byUnit.get(e.unitId!) ?? []), e.incidentId!]);
    for (const ids of byUnit.values()) expect(new Set(ids).size).toBe(ids.length);
    // Closed calls carry timestamps and a hospital.
    const closed = s.incidents.filter(i => i.status === 'closed');
    expect(closed.length).toBeGreaterThan(0);
    for (const c of closed) {
      expect(c.closed_at).toBeTruthy();
      expect(c.hospital.label).toContain('Simulated hospital');
    }
  });

  it('caps open incidents instead of queueing unboundedly', async () => {
    const s = initialState(1_000_000);
    // Freeze all units so no assignment can clear the queue.
    for (const u of s.units) u.status = 'transporting';
    await run(s, 1_000_000, 1_000_000 + 30 * 60 * 1000);
    expect(s.incidents.filter(i => i.status === 'open').length).toBeLessThanOrEqual(MAX_OPEN_INCIDENTS);
  });

  it('leaves every unit inside Bengaluru with a valid status', async () => {
    const s = initialState(1_000_000);
    await run(s, 1_000_000, 1_000_000 + 45 * 60 * 1000);
    for (const u of s.units) {
      expect(u.pos.lat).toBeGreaterThan(12.7); expect(u.pos.lat).toBeLessThan(13.3);
      expect(u.pos.lon).toBeGreaterThan(77.4); expect(u.pos.lon).toBeLessThan(77.9);
      expect(['available', 'en_route', 'at_scene', 'transporting', 'at_hospital']).toContain(u.status);
    }
  });

  it('positionOnLeg interpolates along the polyline and clamps at both ends', () => {
    const leg = { kind: 'to_scene' as const, points: [{ lat: 12.9, lon: 77.6 }, { lat: 12.91, lon: 77.61 }], cum_m: [0, 1400], total_m: 1400, depart_ms: 0, arrive_ms: 100_000, speed_kph: 50, to: { label: 'x', lat: 12.91, lon: 77.61 }, road: true };
    expect(positionOnLeg(leg, 0).pos).toEqual({ lat: 12.9, lon: 77.6 });
    expect(positionOnLeg(leg, 100_000).pos).toEqual({ lat: 12.91, lon: 77.61 });
    const mid = positionOnLeg(leg, 50_000).pos;
    expect(mid.lat).toBeCloseTo(12.905, 5);
    expect(mid.lon).toBeCloseTo(77.605, 5);
    expect(positionOnLeg(leg, 999_000).pos).toEqual({ lat: 12.91, lon: 77.61 });
  });

  it('is deterministic for identical state and clock', async () => {
    const a = initialState(1_000_000);
    const b = initialState(1_000_000);
    await run(a, 1_000_000, 1_000_000 + 20 * 60 * 1000);
    await run(b, 1_000_000, 1_000_000 + 20 * 60 * 1000);
    const norm = (s: SimState) => JSON.stringify(s).replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID');
    expect(norm(a)).toEqual(norm(b));
  });

  it('falls back to straight-line legs when routing returns null', async () => {
    const s = initialState(1_000_000);
    await run(s, s.next_call_ms, s.next_call_ms + 60 * 60 * 1000, 5000, async () => null);
    expect(s.incidents.length).toBeGreaterThan(0);
    expect(s.incidents.some(i => i.status === 'closed')).toBe(true);
    expect(s.units.every(u => u.leg === null || u.leg.road === false)).toBe(true);
  });
});
