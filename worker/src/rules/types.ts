// Structural copies of the contract records. Lane A owns shared/types.ts; these are
// assignment-compatible with it (verified only by reading the contract, not by compiling against it).
export type OperationalStatus = 'available' | 'en_route' | 'at_scene' | 'transporting' | 'at_hospital';
export type VehicleStatus = OperationalStatus | 'offline';
export interface LatLon { lat: number; lon: number }
export interface Destination extends LatLon { label: string }
export interface PingInput { event_id: string; vehicle_id: string; recorded_at: string; lat: number; lon: number; speed_kph: number | null; heading: number | null; telemetry_time?: 'device' | 'receipt' }
export interface Ping extends PingInput { received_at: string; telemetry_time: 'device' | 'receipt' }
export type EtaMethod = 'straight_line' | 'road';
export interface Eta { minutes: number; method: EtaMethod; approximate: true }
export interface RoutePlan { arrive_at: string }
export interface Vehicle {
  id: string; callsign: string; type: 'BLS' | 'ALS'; status: VehicleStatus;
  source: 'stand_in' | 'synthetic' | 'device'; last_seen?: string;
  destination: Destination | null; latest_ping: Ping | null; stale: boolean; eta: Eta | null;
  route?: RoutePlan; incident_id?: string | null;
}
export interface Alert { id: string; vehicle_id: string; kind: 'stale' | 'arrival'; created_at: string; message: string; acknowledged_at: string | null }
export type IncidentStatus = 'open' | 'assigned' | 'on_scene' | 'transporting' | 'closed';
export interface Incident {
  id: string; label: string; lat: number; lon: number; priority: 1 | 2 | 3;
  status: IncidentStatus; created_at: string; assigned_at: string | null; closed_at: string | null;
  vehicle_id: string | null; hospital_label: string | null;
}
export interface FleetSnapshot {
  fleet_id: string; mode: 'demo' | 'live'; server_time: string;
  vehicles: Vehicle[]; alerts: Alert[]; incidents?: Incident[];
  attribution?: { label: string; source: string; url: string }; feed_error?: string;
}
