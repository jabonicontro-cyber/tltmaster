import type { Point, VehicleProfile } from "./route";

// Route builder record shapes, shared by the server loaders (src/server/data/route-planner.ts) and the client panels.

export const LOCATION_KINDS = { yard: "Yard", terminal: "Terminal", quarry: "Quarry", plant: "Plant", pickup: "Material pickup", other: "Other" } as const;
export type LocationKind = keyof typeof LOCATION_KINDS;

export interface CompanyLocation {
  id: string;
  kind: LocationKind;
  name: string;
  address: string;
  addressParts: { line1: string; city: string; state: string; postalCode: string };
  point: Point | null;
  source: "" | "manual" | "geocoded";
  geocodeLabel: string;
  notes: string;
  active: boolean;
}

export interface SiteOption {
  id: string;
  label: string;
  customer: string;
  address: string;
  point: Point | null;
}

export interface TruckOption {
  id: string;
  unit: string;
  vehicle: VehicleProfile;
}

export interface SavedRoute {
  id: string;
  name: string;
  truckId: string | null;
  notes: string;
  stops: Array<{ kind: "location" | "site" | "point"; id: string | null; label: string; point: Point | null; serviceMinutes: number }>;
  updatedAt: string;
}
