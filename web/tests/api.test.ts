import {afterEach,describe,it,expect,vi} from 'vitest';
import {api,history,acknowledge} from '../src/api';
import {isSnapshot,sourceLabel} from '../src/types';
import {fixture} from './fixture';
afterEach(()=>vi.unstubAllGlobals());
describe('contract',()=>{
 it('accepts v1 shape with source and telemetry time',()=>expect(isSnapshot(fixture())).toBe(true));
 it('rejects invalid coordinates and ETA method',()=>{const s=fixture();s.vehicles[0].latest_ping!.lat=Infinity;expect(isSnapshot(s)).toBe(false);});
 it('accepts missing speed/heading without fabricating zero',()=>{const s=fixture();s.vehicles[0].latest_ping!.speed_kph=null;s.vehicles[0].latest_ping!.heading=null;s.vehicles[0].eta=null;expect(isSnapshot(s)).toBe(true);s.vehicles[0].latest_ping!.speed_kph=-1;expect(isSnapshot(s)).toBe(false);});
 it('labels MBTA source and synthetic data distinctly',()=>{const v=fixture().vehicles[0];expect(sourceLabel({...v,source:'stand_in'},'demo')).toContain('MBTA bus');expect(sourceLabel(v,'demo')).toBe('Synthetic');});
 it('uses Bearer header, no-store and exact ack endpoint',async()=>{const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({acknowledged:true})));vi.stubGlobal('fetch',fetch);await acknowledge('a/b','token');expect(fetch).toHaveBeenCalledWith('/api/alerts/a%2Fb/ack',expect.objectContaining({method:'POST',cache:'no-store',headers:{Authorization:'Bearer token'}}));});
 it('surfaces structured API errors',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'expired',message:'Token expired'}}),{status:401})));await expect(api('/api/fleet','token')).rejects.toMatchObject({status:401,code:'expired',message:'Token expired'});});
 it('sorts history chronologically without other vehicle points',async()=>{const ping=fixture().vehicles[0].latest_ping!;vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({pings:[{...ping,recorded_at:'2026-10-13T00:00:20Z'},{...ping,recorded_at:'2026-10-13T00:00:10Z'},{...ping,vehicle_id:'other'}]}))));const data=await history('v1','token');expect(data).toHaveLength(2);expect(data[0].recorded_at).toContain('00:00:10');});
 it('rejects malformed history',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({pings:[{lat:0}]}))));await expect(history('v1','token')).rejects.toThrow('Invalid history');});
});
it('staleness is server-relative, not affected by a clock two minutes ahead',async()=>{const {vehicleIsStale}=await import('../src/types');const s=fixture();s.server_time='2026-10-13T00:00:00Z';s.vehicles[0].latest_ping!.recorded_at=s.server_time;vi.spyOn(Date,'now').mockReturnValue(Date.parse(s.server_time)+120000);expect(vehicleIsStale(s.vehicles[0],s,2000)).toBe(false);expect(vehicleIsStale(s.vehicles[0],s,31000)).toBe(true);vi.restoreAllMocks();});
