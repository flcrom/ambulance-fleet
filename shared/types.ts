export type OperationalStatus = 'available' | 'en_route' | 'at_scene' | 'transporting' | 'at_hospital';
export interface Destination { label: string; lat: number; lon: number }
export interface PingInput { event_id: string; vehicle_id: string; recorded_at: string; lat: number; lon: number; speed_kph: number | null; heading: number | null; telemetry_time?: 'device' | 'receipt' }
export interface Ping extends PingInput { received_at: string }
export interface Vehicle { id: string; callsign: string; type: 'BLS' | 'ALS'; status: OperationalStatus | 'offline'; source: 'stand_in' | 'synthetic' | 'device'; last_seen?: string; destination: Destination | null; latest_ping: Ping | null; stale: boolean; eta: { minutes: number; method: 'straight_line'; approximate: true } | null }
export interface Alert { id: string; vehicle_id: string; kind: 'stale' | 'arrival'; created_at: string; message: string; acknowledged_at: string | null }
export interface FleetSnapshot { fleet_id: string; mode: 'demo' | 'live'; server_time: string; vehicles: Vehicle[]; alerts: Alert[]; attribution?: {label:string;source:string;url:string}; feed_error?:string }
export type SnapshotEvent = { type: 'snapshot'; data: FleetSnapshot };
