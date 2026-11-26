/**
 * Server-owned dispatch simulation for the public demo fleet. Deterministic per
 * state evolution (seeded rng, wall-clock timestamps) so tests reproduce exactly.
 * Everything here is simulated: invented stations and hospitals, generated calls.
 * No real hospital, operator or emergency service participates.
 */
import { distanceMeters } from '../rules/geo';
import type { Destination, OperationalStatus } from '../rules/types';
import { BASES, CALL_LOCATIONS, HOSPITALS } from './bengaluru';

export interface LatLon { lat: number; lon: number }
export interface RouteResult { points: LatLon[]; total_m: number }
export type Router = (from: LatLon, to: LatLon) => Promise<RouteResult | null>;

export type LegKind = 'to_scene' | 'to_hospital' | 'to_base';
export interface LegPlan {
  kind: LegKind;
  points: LatLon[];
  cum_m: number[];
  total_m: number;
  depart_ms: number;
  arrive_ms: number;
  speed_kph: number;
  to: Destination;
  road: boolean;
}
export interface SimUnit {
  id: string; callsign: string; type: 'BLS' | 'ALS';
  base: Destination;
  status: OperationalStatus;
  incident_id: string | null;
  leg: LegPlan | null;
  dwell_until_ms: number | null;
  pos: LatLon;
}
export interface SimIncident {
  id: string; label: string; lat: number; lon: number;
  priority: 1 | 2 | 3;
  status: 'open' | 'assigned' | 'on_scene' | 'transporting' | 'closed';
  created_at: string; assigned_at: string | null; closed_at: string | null;
  vehicle_id: string | null;
  hospital: Destination;
}
export interface SimState {
  version: 2;
  units: SimUnit[];
  incidents: SimIncident[];
  next_call_ms: number;
  seq: number;
}
export type SimEvent =
  | { type: 'call'; incident: SimIncident }
  | { type: 'dispatched'; incident: SimIncident; unit: SimUnit }
  | { type: 'arrived_scene'; incident: SimIncident; unit: SimUnit }
  | { type: 'transporting'; incident: SimIncident; unit: SimUnit }
  | { type: 'arrived_hospital'; incident: SimIncident; unit: SimUnit }
  | { type: 'unit_available'; unit: SimUnit };

export const MAX_OPEN_INCIDENTS = 4;
export const MAX_KEPT_INCIDENTS = 16;
const CALL_GAP_MIN_MS = 45_000;
const CALL_GAP_SPREAD_MS = 75_000;
const SCENE_DWELL_MIN_MS = 60_000;
const SCENE_DWELL_SPREAD_MS = 90_000;
const HOSPITAL_DWELL_MIN_MS = 90_000;
const HOSPITAL_DWELL_SPREAD_MS = 150_000;
const MIN_SPEED_KPH = 16;
const SPEED_SPREAD_KPH = 14;
const MAX_CATCH_UP_CALLS = 3;

/** mulberry32: small deterministic PRNG. Seed derives only from sim state. */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function initialState(nowMs: number): SimState {
  const units: SimUnit[] = [];
  for (let i = 0; i < 8; i++) {
    const base = BASES[i % BASES.length];
    units.push({
      id: `SIR-${String(i + 1).padStart(2, '0')}`,
      callsign: `Siren ${i + 1}`,
      type: i % 3 === 0 ? 'ALS' : 'BLS',
      base: { label: base.label, lat: base.lat, lon: base.lon },
      status: 'available',
      incident_id: null,
      leg: null,
      dwell_until_ms: null,
      pos: { lat: base.lat, lon: base.lon },
    });
  }
  return { version: 2, units, incidents: [], next_call_ms: nowMs + 20_000, seq: 1 };
}

function nextRandom(state: SimState): number {
  const r = rng(state.seq * 2654435761)();
  state.seq += 1;
  return r;
}

export function positionOnLeg(leg: LegPlan, nowMs: number): { pos: LatLon; heading: number } {
  const span = leg.arrive_ms - leg.depart_ms;
  const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - leg.depart_ms) / span));
  const d = t * leg.total_m;
  const cum = leg.cum_m;
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < d) i++;
  const a = leg.points[i], b = leg.points[Math.min(i + 1, leg.points.length - 1)];
  const seg = cum[Math.min(i + 1, cum.length - 1)] - cum[i];
  const f = seg <= 0 ? 0 : (d - cum[i]) / seg;
  const lat = a.lat + (b.lat - a.lat) * f;
  const lon = a.lon + (b.lon - a.lon) * f;
  const heading = (Math.atan2(b.lon - a.lon, b.lat - a.lat) * 180 / Math.PI + 360) % 360;
  return { pos: { lat, lon }, heading };
}

function makeLeg(kind: LegKind, from: LatLon, to: Destination, departMs: number, route: RouteResult | null, speedKph: number): LegPlan {
  const points = route && route.points.length >= 2 ? route.points : [{ ...from }, { lat: to.lat, lon: to.lon }];
  const cum_m: number[] = [0];
  for (let i = 1; i < points.length; i++) cum_m.push(cum_m[i - 1] + distanceMeters(points[i - 1], points[i]));
  const rawTotal = cum_m[cum_m.length - 1];
  const total_m = route && route.total_m > 0 ? route.total_m : rawTotal;
  // Scale cumulative distances to the provider's total when they disagree.
  const scale = rawTotal > 0 && total_m !== rawTotal ? total_m / rawTotal : 1;
  const scaled = scale === 1 ? cum_m : cum_m.map(v => v * scale);
  const arrive_ms = departMs + Math.max(5_000, total_m / (speedKph / 3.6) * 1000);
  return { kind, points, cum_m: scaled, total_m, depart_ms: departMs, arrive_ms, speed_kph: speedKph, to, road: route !== null && route.points.length >= 2 };
}

function nearestAvailable(units: SimUnit[], at: LatLon): SimUnit | null {
  let best: SimUnit | null = null; let bestM = Infinity;
  for (const u of units) {
    if (u.status !== 'available') continue;
    const d = distanceMeters(u.pos, at);
    if (d < bestM) { bestM = d; best = u; }
  }
  return best;
}

function nearestHospital(at: LatLon): Destination {
  let best = HOSPITALS[0]; let bestM = Infinity;
  for (const h of HOSPITALS) {
    const d = distanceMeters(at, h);
    if (d < bestM) { bestM = d; best = h; }
  }
  return best;
}

function pruneIncidents(state: SimState): void {
  const active = state.incidents.filter(i => i.status !== 'closed');
  const closed = state.incidents.filter(i => i.status === 'closed')
    .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''));
  state.incidents = [...active, ...closed].slice(0, MAX_KEPT_INCIDENTS);
}

/**
 * Advance the simulation to `nowMs`. Processes due calls, assignments, arrivals
 * and dwell transitions in timestamp order. Returns ops events for alerting.
 */
export async function advance(state: SimState, nowMs: number, route: Router): Promise<SimEvent[]> {
  const events: SimEvent[] = [];
  // Generate due calls; after long idle, do not burst more than MAX_CATCH_UP_CALLS.
  let generated = 0;
  while (state.next_call_ms <= nowMs && generated < MAX_CATCH_UP_CALLS) {
    const openCount = state.incidents.filter(i => i.status === 'open').length;
    if (openCount >= MAX_OPEN_INCIDENTS) { state.next_call_ms = nowMs + 30_000; break; }
    const at = CALL_LOCATIONS[Math.floor(nextRandom(state) * CALL_LOCATIONS.length)];
    const roll = nextRandom(state);
    const incident: SimIncident = {
      id: crypto.randomUUID(),
      label: at.label, lat: at.lat, lon: at.lon,
      priority: roll < 0.55 ? 1 : roll < 0.85 ? 2 : 3,
      status: 'open', created_at: new Date(state.next_call_ms).toISOString(),
      assigned_at: null, closed_at: null, vehicle_id: null,
      hospital: nearestHospital(at),
    };
    state.incidents.push(incident);
    events.push({ type: 'call', incident });
    generated += 1;
    state.next_call_ms = state.next_call_ms + CALL_GAP_MIN_MS + nextRandom(state) * CALL_GAP_SPREAD_MS;
  }
  if (state.next_call_ms < nowMs) state.next_call_ms = nowMs + 30_000;

  // Assign open incidents, highest priority then oldest.
  const open = state.incidents.filter(i => i.status === 'open')
    .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  for (const incident of open) {
    const unit = nearestAvailable(state.units, incident);
    if (!unit) break;
    const speed = MIN_SPEED_KPH + nextRandom(state) * SPEED_SPREAD_KPH;
    const routeResult = await route(unit.pos, incident);
    unit.leg = makeLeg('to_scene', unit.pos, incident, nowMs, routeResult, speed);
    unit.status = 'en_route';
    unit.incident_id = incident.id;
    unit.dwell_until_ms = null;
    incident.status = 'assigned';
    incident.assigned_at = new Date(nowMs).toISOString();
    incident.vehicle_id = unit.id;
    events.push({ type: 'dispatched', incident, unit });
  }

  // Progress units.
  for (const unit of state.units) {
    if (unit.leg) {
      if (nowMs >= unit.leg.arrive_ms) {
        unit.pos = { lat: unit.leg.to.lat, lon: unit.leg.to.lon };
        const kind = unit.leg.kind;
        unit.leg = null;
        if (kind === 'to_scene') {
          unit.status = 'at_scene';
          unit.dwell_until_ms = nowMs + SCENE_DWELL_MIN_MS + nextRandom(state) * SCENE_DWELL_SPREAD_MS;
          const incident = state.incidents.find(i => i.id === unit.incident_id);
          if (incident && incident.status === 'assigned') { incident.status = 'on_scene'; events.push({ type: 'arrived_scene', incident, unit }); }
        } else if (kind === 'to_hospital') {
          unit.status = 'at_hospital';
          unit.dwell_until_ms = nowMs + HOSPITAL_DWELL_MIN_MS + nextRandom(state) * HOSPITAL_DWELL_SPREAD_MS;
          const incident = state.incidents.find(i => i.id === unit.incident_id);
          if (incident && incident.status !== 'closed') {
            incident.status = 'closed'; incident.closed_at = new Date(nowMs).toISOString();
            events.push({ type: 'arrived_hospital', incident, unit });
          }
          unit.incident_id = null;
        } else {
          unit.status = 'available';
          unit.dwell_until_ms = null;
          events.push({ type: 'unit_available', unit });
        }
      } else {
        unit.pos = positionOnLeg(unit.leg, nowMs).pos;
      }
      continue;
    }
    if (unit.dwell_until_ms !== null && nowMs >= unit.dwell_until_ms) {
      unit.dwell_until_ms = null;
      const speed = MIN_SPEED_KPH + nextRandom(state) * SPEED_SPREAD_KPH;
      if (unit.status === 'at_scene') {
        const incident = state.incidents.find(i => i.id === unit.incident_id);
        const hospital = incident ? incident.hospital : nearestHospital(unit.pos);
        const routeResult = await route(unit.pos, hospital);
        unit.leg = makeLeg('to_hospital', unit.pos, hospital, nowMs, routeResult, speed);
        unit.status = 'transporting';
        if (incident && incident.status === 'on_scene') { incident.status = 'transporting'; events.push({ type: 'transporting', incident, unit }); }
      } else if (unit.status === 'at_hospital') {
        const routeResult = await route(unit.pos, unit.base);
        unit.leg = makeLeg('to_base', unit.pos, unit.base, nowMs, routeResult, speed);
        unit.status = 'en_route';
      }
    }
  }
  pruneIncidents(state);
  return events;
}
