/**
 * Road routes for the demo simulation from the public OSRM demo server
 * (https://router.project-osrm.org), OpenStreetMap data. Light, cached use only:
 * a route is fetched once per dispatch leg and stored in the fleet's Durable
 * Object. Any failure returns null and the simulation falls back to an honest
 * straight-line leg marked as such.
 */
import type { LatLon, RouteResult } from './sim';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving/';

export async function fetchOsrmRoute(from: LatLon, to: LatLon, fetcher: typeof fetch = fetch): Promise<RouteResult | null> {
  try {
    const url = `${OSRM_BASE}${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'SirenDispatchDemo/1.0 (https://github.com/flcrom/ambulance-fleet; contact via repo)' },
    });
    if (!response.ok) { console.error(`OSRM route request failed: HTTP ${response.status}`); return null; }
    const body = await response.json() as { code?: string; routes?: { distance?: number; geometry?: { coordinates?: [number, number][] } }[] };
    const route = body.routes?.[0];
    const coords = route?.geometry?.coordinates;
    if (body.code !== 'Ok' || !route || !Array.isArray(coords) || coords.length < 2 || typeof route.distance !== 'number' || !Number.isFinite(route.distance) || route.distance <= 0) return null;
    const points: LatLon[] = [];
    for (const c of coords) {
      if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
      points.push({ lat: c[1], lon: c[0] });
    }
    return { points, total_m: route.distance };
  } catch (err) {
    console.error(`OSRM route request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export const routeCacheKey = (from: LatLon, to: LatLon): string =>
  `${from.lat.toFixed(4)},${from.lon.toFixed(4)}>${to.lat.toFixed(4)},${to.lon.toFixed(4)}`;
