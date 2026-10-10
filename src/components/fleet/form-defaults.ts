// Form value shapes and empty defaults. Kept out of the "use client" form
// modules so server pages can read and spread them.
import type { TrailerType, TruckType, WeightUnit } from "@/server/data/types";

export interface EquipmentFormValues {
  unit_number: string;
  type: TruckType | TrailerType | "";
  make: string;
  model: string;
  model_year: number | null;
  vin: string;
  license_plate: string;
  plate_state: string;
  weight_capacity: string | number | null;
  weight_unit: WeightUnit | null;
  volume_capacity: string | number | null;
  capacity_source: string;
  capacity_verified: boolean;
  notes: string;
  // Trailers only
  compatible_truck_types?: TruckType[];
  compatibility_notes?: string;
  default_truck_id?: string | null;
}

export const EMPTY_EQUIPMENT: EquipmentFormValues = {
  unit_number: "",
  type: "",
  make: "",
  model: "",
  model_year: null,
  vin: "",
  license_plate: "",
  plate_state: "IN",
  weight_capacity: null,
  weight_unit: null,
  volume_capacity: null,
  capacity_source: "",
  capacity_verified: false,
  notes: "",
  compatible_truck_types: [],
  compatibility_notes: "",
  default_truck_id: null,
};

export interface DriverFormValues {
  user_id: string | null;
  name: string;
  employee_number: string;
  phone: string;
  hire_date: string | null;
  notes: string;
}

export const EMPTY_DRIVER: DriverFormValues = { user_id: null, name: "", employee_number: "", phone: "", hire_date: null, notes: "" };

