// Row shapes returned by the data-access layer. bigint columns (cents) arrive
// from PostgREST as JSON numbers; values stay well within the safe-integer range.
import type { CalcMethod, ChargeKind } from "@/lib/quotes/calc";
import type { QuoteStatus } from "@/lib/quotes/status";

export interface CustomerRow {
  id: string;
  customer_number: string;
  name: string;
  customer_type: "commercial" | "residential";
  email: string;
  phone: string;
  billing_line1: string;
  billing_line2: string;
  billing_city: string;
  billing_state: string;
  billing_postal_code: string;
  po_required: boolean;
  po_instructions: string;
  payment_terms: string;
  price_list_id: string | null;
  tax_exempt: boolean;
  notes: string;
  active: boolean;
  is_sample: boolean;
  created_at: string;
  updated_at: string;
}

export interface ContactRow {
  id: string;
  customer_id: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  is_primary: boolean;
  is_billing: boolean;
  notes: string;
  active: boolean;
}

export interface SiteRow {
  id: string;
  customer_id: string;
  label: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  directions: string;
  active: boolean;
}

export interface UnitRow {
  code: string;
  label: string;
  abbreviation: string;
  active: boolean;
  sort_order: number;
}

export interface MaterialRow {
  id: string;
  code: string | null;
  name: string;
  description: string;
  default_unit_code: string;
  taxable_default: boolean;
  active: boolean;
  is_sample: boolean;
  updated_at: string;
}

export interface ChargeItemRow {
  id: string;
  code: string | null;
  name: string;
  description: string;
  kind: Exclude<ChargeKind, "material">;
  calc_method: CalcMethod;
  default_unit_code: string | null;
  taxable_default: boolean;
  active: boolean;
  is_sample: boolean;
}

export interface PriceListRow {
  id: string;
  name: string;
  description: string;
  is_standard: boolean;
  active: boolean;
  is_sample: boolean;
}

export interface PriceEntryRow {
  id: string;
  price_list_id: string;
  material_id: string | null;
  charge_item_id: string | null;
  unit_code: string | null;
  rate_cents: number | null;
  percent_bp: number | null;
  effective_from: string;
  effective_to: string | null;
  notes: string;
}

export interface EffectivePrice {
  material_id: string | null;
  charge_item_id: string | null;
  unit_code: string | null;
  rate_cents: number | null;
  percent_bp: number | null;
  source: "customer" | "standard";
}

export interface QuoteListRow {
  id: string;
  quote_number: string;
  status: QuoteStatus;
  customer_id: string;
  customer_name: string;
  customer_number: string;
  is_sample: boolean;
  created_at: string;
  updated_at: string;
  first_sent_at: string | null;
  last_sent_at: string | null;
  accepted_at: string | null;
  version_id: string;
  version_no: number;
  quote_date: string;
  valid_until: string;
  project_name: string;
  site_label: string;
  site_line1: string;
  site_city: string;
  total_cents: number;
  locked_at: string | null;
}

export interface QuoteRow {
  id: string;
  quote_number: string;
  customer_id: string;
  status: QuoteStatus;
  current_version_id: string;
  accepted_version_id: string | null;
  first_sent_at: string | null;
  last_sent_at: string | null;
  accepted_at: string | null;
  closed_at: string | null;
  status_note: string;
  is_sample: boolean;
  created_at: string;
  updated_at: string;
}

export interface QuoteVersionRow {
  id: string;
  quote_id: string;
  version_no: number;
  edit_seq: number;
  contact_id: string | null;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  site_id: string | null;
  site_label: string;
  site_line1: string;
  site_line2: string;
  site_city: string;
  site_state: string;
  site_postal_code: string;
  quote_date: string;
  valid_until: string;
  project_name: string;
  customer_po: string;
  job_instructions: string;
  terms: string;
  internal_notes: string;
  tax_rate_bp: number;
  subtotal_cents: number;
  discount_cents: number;
  taxable_cents: number;
  tax_cents: number;
  total_cents: number;
  revision_reason: string;
  locked_at: string | null;
  sent_at: string | null;
  bill_to_snapshot: BillToSnapshot | null;
  company_snapshot: CompanySnapshot | null;
  created_at: string;
  updated_at: string;
}

export interface BillToSnapshot {
  customer_number: string;
  name: string;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  payment_terms: string;
}

export interface CompanySnapshot {
  company_name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal_code: string;
  phone: string;
  email: string;
  website: string;
  footer_note: string;
  timezone: string;
}

export interface QuoteLineRow {
  id: string;
  quote_version_id: string;
  line_no: number;
  kind: ChargeKind;
  calc_method: CalcMethod;
  material_id: string | null;
  charge_item_id: string | null;
  description: string;
  unit_code: string | null;
  unit_label: string;
  quantity: string | null;
  unit_rate_cents: number | null;
  percent_bp: number | null;
  catalog_rate_cents: number | null;
  catalog_percent_bp: number | null;
  price_source: "customer" | "standard" | "manual" | "override";
  taxable: boolean;
  amount_cents: number;
}

export interface StatusEventRow {
  id: string;
  quote_id: string;
  version_id: string | null;
  from_status: QuoteStatus | null;
  to_status: QuoteStatus;
  note: string;
  actor_id: string | null;
  occurred_at: string;
}

export interface DeliveryRow {
  id: string;
  quote_version_id: string;
  channel: "email" | "manual";
  status: "sent" | "failed" | "preview" | "test_sent";
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  provider: string;
  provider_message_id: string | null;
  error_message: string | null;
  note: string;
  created_by: string | null;
  created_at: string;
  documents: { filename: string; sha256: string; byte_size: number } | null;
}

export interface CompanySettings {
  company_name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  phone: string;
  email: string;
  website: string;
  timezone: string;
  default_tax_rate_bp: number;
  quote_validity_days: number;
  quote_followup_days: number;
  default_quote_terms: string;
  quote_footer_note: string;
  updated_at: string;
}

export type OrderStatus =
  | "draft"
  | "confirmed"
  | "scheduled"
  | "dispatched"
  | "in_progress"
  | "partially_completed"
  | "completed"
  | "on_hold"
  | "canceled";

export interface OrderListRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  customer_id: string;
  customer_name: string;
  customer_number: string;
  source_quote_id: string | null;
  source_quote_number: string | null;
  project_name: string;
  site_label: string;
  site_line1: string;
  site_city: string;
  customer_po: string;
  total_cents: number;
  is_sample: boolean;
  created_at: string;
}

export interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  status: OrderStatus;
  source_quote_id: string | null;
  source_quote_version_id: string | null;
  bill_to_snapshot: BillToSnapshot | null;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  site_id: string | null;
  site_label: string;
  site_line1: string;
  site_line2: string;
  site_city: string;
  site_state: string;
  site_postal_code: string;
  project_name: string;
  customer_po: string;
  job_instructions: string;
  terms: string;
  internal_notes: string;
  tax_rate_bp: number;
  subtotal_cents: number;
  discount_cents: number;
  taxable_cents: number;
  tax_cents: number;
  total_cents: number;
  status_note: string;
  is_sample: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type OrderLineRow = Omit<QuoteLineRow, "quote_version_id"> & {
  order_id: string;
  source_quote_line_id: string | null;
};

export interface OrderStatusEventRow {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  note: string;
  actor_id: string | null;
  occurred_at: string;
}
