// Structural copies of the contract records. Lane A owns shared/types.ts; these are
// assignment-compatible with it (verified only by reading the contract, not by compiling against it).
export type VehicleStatus = 'available' | 'en_route' | 'at_scene' | 'transporting' | 'at_hospital' | 'offline';
export interface LatLon { lat: number; lon: number }
export interface PingInput {
  event_id: string; vehicle_id: string; recorded_at: string;
  lat: number; lon: number; speed_kph: number | null; heading: number | null;
  telemetry_time?: 'device' | 'receipt';
}
export interface Ping extends PingInput { received_at: string; telemetry_time?: 'device' | 'receipt' }
export interface Destination extends LatLon { label: string }
export interface Eta { minutes: number; method: 'straight_line'; approximate: true }
export interface Vehicle {
  id: string; callsign: string; type: 'BLS' | 'ALS'; source?: 'device' | 'synthetic' | 'stand_in'; status: VehicleStatus;
  last_seen?: string; destination: Destination | null; latest_ping: Ping | null; stale: boolean; eta: Eta | null;
}
export interface Alert {
  id: string; vehicle_id: string; kind: 'stale' | 'arrival';
  created_at: string; message: string; acknowledged_at: string | null;
}
