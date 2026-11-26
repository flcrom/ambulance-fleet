// Simulated fleet geography. Station and hospital names are invented; no real
// hospital or operator participates in the demo. Call locations are public
// neighbourhood names used only so a simulated call lands in a real place.
import type { Destination } from '../rules/types';

export interface SimBase extends Destination { id: string }

export const BASES: SimBase[] = [
  { id: 'base-hsr', label: 'Siren station 1 · HSR Layout (simulated)', lat: 12.9116, lon: 77.6474 },
  { id: 'base-ind', label: 'Siren station 2 · Indiranagar (simulated)', lat: 12.9719, lon: 77.6412 },
  { id: 'base-jay', label: 'Siren station 3 · Jayanagar (simulated)', lat: 12.9308, lon: 77.5838 },
];

export const HOSPITALS: Destination[] = [
  { label: 'Simulated hospital A', lat: 12.9352, lon: 77.6245 },
  { label: 'Simulated hospital B', lat: 12.9698, lon: 77.7500 },
  { label: 'Simulated hospital C', lat: 12.9250, lon: 77.5937 },
  { label: 'Simulated hospital D', lat: 13.0358, lon: 77.5970 },
];

export const CALL_LOCATIONS: Destination[] = [
  { label: 'Koramangala 4th Block', lat: 12.9345, lon: 77.6260 },
  { label: 'Koramangala 80 Feet Road', lat: 12.9398, lon: 77.6205 },
  { label: 'HSR Layout 27th Main', lat: 12.9141, lon: 77.6412 },
  { label: 'HSR Layout Agara Lake', lat: 12.9050, lon: 77.6485 },
  { label: 'Indiranagar 100 Feet Road', lat: 12.9690, lon: 77.6490 },
  { label: 'Domlur', lat: 12.9610, lon: 77.6387 },
  { label: 'MG Road', lat: 12.9757, lon: 77.6013 },
  { label: 'Brigade Road', lat: 12.9716, lon: 77.5946 },
  { label: 'Richmond Town', lat: 12.9652, lon: 77.6000 },
  { label: 'Jayanagar 4th Block', lat: 12.9308, lon: 77.5838 },
  { label: 'JP Nagar 6th Phase', lat: 12.9077, lon: 77.5851 },
  { label: 'Banashankari 2nd Stage', lat: 12.9129, lon: 77.5563 },
  { label: 'Basavanagudi', lat: 12.9448, lon: 77.5738 },
  { label: 'Majestic', lat: 12.9767, lon: 77.5713 },
  { label: 'Malleshwaram', lat: 13.0035, lon: 77.5647 },
  { label: 'Rajajinagar', lat: 12.9915, lon: 77.5512 },
  { label: 'Yeshwanthpur', lat: 13.0280, lon: 77.5408 },
  { label: 'Hebbal', lat: 13.0358, lon: 77.5970 },
  { label: 'Frazer Town', lat: 12.9989, lon: 77.6130 },
  { label: 'Shivajinagar', lat: 12.9857, lon: 77.6057 },
  { label: 'Marathahalli', lat: 12.9591, lon: 77.6974 },
  { label: 'Bellandur', lat: 12.9260, lon: 77.6762 },
  { label: 'Sarjapur Road', lat: 12.9000, lon: 77.6873 },
  { label: 'Electronic City Phase 1', lat: 12.8452, lon: 77.6602 },
  { label: 'Whitefield', lat: 12.9698, lon: 77.7500 },
  { label: 'KR Puram', lat: 13.0068, lon: 77.6874 },
  { label: 'BTM Layout 2nd Stage', lat: 12.9165, lon: 77.6101 },
  { label: 'Wilson Garden', lat: 12.9490, lon: 77.5940 },
];
