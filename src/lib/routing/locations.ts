import { industryOf } from "@/lib/industry";
import type { Point, VehicleProfile } from "./route";

// Route builder record shapes, shared by the server loaders (src/server/data/route-planner.ts) and the client panels.

export const LOCATION_KINDS = { yard: "Yard", terminal: "Terminal", quarry: "Quarry", plant: "Plant", pickup: "Material pickup", shipper: "Shipper", receiver: "Receiver", warehouse: "Warehouse", other: "Other" } as const;
export type LocationKind = keyof typeof LOCATION_KINDS;

/** The place kinds a company is offered (MK4, 20261120008100): quarries and plants for aggregate, shippers and receivers
 * for freight; a place already saved with another kind keeps it. */
export function locationKindsFor(industry: unknown, current?: string | null): LocationKind[] {
  const i = industryOf(industry);
  const list: LocationKind[] = i === "freight" ? ["yard", "terminal", "shipper", "receiver", "warehouse", "other"]
    : i === "aggregate" ? ["yard", "terminal", "quarry", "plant", "pickup", "other"]
    : (Object.keys(LOCATION_KINDS) as LocationKind[]);
  return (Object.keys(LOCATION_KINDS) as LocationKind[]).filter((k) => list.includes(k) || k === current);
}

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
