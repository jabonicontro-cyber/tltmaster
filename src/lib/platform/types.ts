export interface PlatformCompany {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  created_at: string;
  members: number;
  customers: number;
  trucks: number;
  drivers: number;
  materials: number;
}

export interface ImportBatchSummary {
  id: string;
  entity: string;
  status: "review" | "approved" | "reverted" | "discarded";
  file_name: string;
  created_at: string;
  created_by: string | null;
  rows: number;
  valid: number;
  duplicates: number;
  errors: number;
  to_import: number;
  result: { created?: number; removed?: number; kept_inactive?: number };
}

export interface ImportRow {
  id: string;
  row: number;
  data: Record<string, string>;
  status: "valid" | "error" | "duplicate";
  messages: string[];
  can_override: boolean;
  decision: "import" | "skip";
  outcome: "" | "created" | "removed" | "kept_changed" | "kept_in_use";
}

export interface ImportBatch {
  id: string;
  company_id: string;
  company_name: string;
  entity: "customers" | "materials" | "trucks" | "drivers";
  status: ImportBatchSummary["status"];
  file_name: string;
  created_at: string;
  decided_at: string | null;
  reverted_at: string | null;
  revert_reason: string;
  result: ImportBatchSummary["result"];
  rows: ImportRow[];
}
