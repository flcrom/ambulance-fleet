/** Structural subset of the shared contract; no dependency on sibling source. */
export interface FeedPing {
  event_id: string; vehicle_id: string; recorded_at: string; lat: number; lon: number;
  speed_kph: number|null; heading: number|null; telemetry_time: 'device' | 'receipt';
}
export interface FeedVehicle { id: string; callsign: string; type: 'BLS' | 'ALS'; source: 'stand_in' | 'synthetic' }
export interface FeedSample { vehicle: FeedVehicle; ping: FeedPing }
export async function stableUuid(parts: readonly unknown[]): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts))));
  digest[6] = (digest[6] & 15) | 0x80; // RFC 9562 version 8: application-defined hash UUID
  digest[8] = (digest[8] & 63) | 0x80;
  const h = Array.from(digest.slice(0, 16), x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function assertPing(p: FeedPing, now = Date.now()): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.event_id) || !p.vehicle_id) throw new Error('Invalid ping identity');
  if (![p.lat,p.lon].every(Number.isFinite) || Math.abs(p.lat)>90 || Math.abs(p.lon)>180 || (p.speed_kph!==null&&(!Number.isFinite(p.speed_kph)||p.speed_kph<0||p.speed_kph>200)) || (p.heading!==null&&(!Number.isFinite(p.heading)||p.heading<0||p.heading>=360))) throw new Error('Invalid ping coordinates or motion');
  const time = Date.parse(p.recorded_at);
  if (!Number.isFinite(time) || time > now+60000 || time < now-86400000 || !['device','receipt'].includes(p.telemetry_time)) throw new Error('Invalid telemetry time');
}
export class IngestClient {
  private base: URL;
  constructor(base: string, private token: string, private fetcher: typeof fetch = fetch) {
    this.base = new URL(base);
    if (this.base.protocol !== 'https:' && !(this.base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(this.base.hostname))) throw new Error('HTTPS required except localhost');
    if (this.base.username || this.base.password || this.base.search || this.base.hash || !token) throw new Error('Invalid API configuration');
  }
  private async request(path: string, value: unknown): Promise<Response> {
    // Origin-only URLs avoid accidentally posting credentials to a redirected host.
    return this.fetcher(new URL(path, this.base.origin), {method:'POST', redirect:'manual', signal:AbortSignal.timeout(10000), headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
  }
  async register(v: FeedVehicle): Promise<void> {
    const r = await this.request('/api/vehicles',v);
    if (r.status!==201 && r.status!==409) throw new Error(`Vehicle registration rejected: ${r.status}`);
    // Conflict alone does not prove source identity; inspect snapshot before posting.
    if (r.status===409) {
      const snap = await this.fetcher(new URL('/api/fleet',this.base.origin),{redirect:'manual', signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${this.token}`}});
      if (!snap.ok) throw new Error(`Cannot verify existing vehicle: ${snap.status}`);
      const body = await snap.json() as {vehicles?: FeedVehicle[]};
      const existing = body.vehicles?.find(x=>x.id===v.id);
      if (!existing || existing.source!==v.source || existing.callsign!==v.callsign) throw new Error('Existing vehicle identity/source mismatch');
    }
  }
  async post(p: FeedPing): Promise<void> {
    assertPing(p);
    const r = await this.request('/api/pings',p);
    if (r.status!==200 && r.status!==201) throw new Error(`Ping rejected: ${r.status}`);
    const b = await r.json() as {accepted?:boolean;event_id?:string;duplicate?:boolean};
    if (b.accepted!==true || b.event_id!==p.event_id || typeof b.duplicate!=='boolean') throw new Error('API did not confirm acceptance');
  }
}
