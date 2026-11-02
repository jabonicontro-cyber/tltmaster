// Digital inspection items (B132): the standard driver vehicle inspection report items (49 CFR 396.11). The keys match
// private.inspection_items() in 20261120006000; a defect in a safety item takes the truck out of service.
export const INSPECTION_ITEMS = [
  { key: "service_brakes", label: "Service brakes", safety: true },
  { key: "parking_brake", label: "Parking brake", safety: true },
  { key: "steering", label: "Steering", safety: true },
  { key: "lights_reflectors", label: "Lights and reflectors", safety: true },
  { key: "tires", label: "Tires", safety: true },
  { key: "wheels_rims", label: "Wheels and rims", safety: true },
  { key: "coupling", label: "Coupling devices", safety: true },
  { key: "horn", label: "Horn", safety: false },
  { key: "wipers", label: "Windshield wipers", safety: false },
  { key: "mirrors", label: "Rear-view mirrors", safety: false },
  { key: "emergency_equipment", label: "Emergency equipment", safety: false },
] as const;

export type InspectionKey = (typeof INSPECTION_ITEMS)[number]["key"];
export type InspectionKind = "pre_trip" | "post_trip";
export const KIND_LABEL: Record<InspectionKind, string> = { pre_trip: "Pre-trip", post_trip: "Post-trip" };
export const itemLabel = (key: string) => INSPECTION_ITEMS.find((i) => i.key === key)?.label ?? key.replace(/_/g, " ");
