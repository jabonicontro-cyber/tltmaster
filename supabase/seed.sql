-- =============================================================================
-- SAMPLE DATA — fictional customers, materials and placeholder rates for
-- development and training. Every row is flagged is_sample = true, shown with
-- a "SAMPLE" badge in the app, and can be removed from Settings → Sample data.
-- Names, addresses, emails and phone numbers are invented. Rates are round
-- placeholders, NOT company prices.
-- =============================================================================

-- Materials --------------------------------------------------------------------
insert into public.materials (code, name, description, default_unit_code, taxable_default, is_sample) values
  ('GRV-53',  'Gravel #53 limestone',  'Crushed limestone base, #53 gradation (sample item).', 'ton', true, true),
  ('GRV-8',   'Gravel #8',             'Washed #8 stone (sample item).',                       'ton', true, true),
  ('SND-FILL','Fill sand',             'Sample fill sand.',                                    'ton', true, true),
  ('QRY-2',   'Quarry stone #2',       'Large quarry stone (sample item).',                    'ton', true, true),
  ('DIRT-FL', 'Fill dirt',             'Clean fill dirt (sample item).',                       'load', true, true),
  ('TOPSOIL', 'Screened topsoil',      'Screened topsoil (sample item).',                      'cu_yd', true, true),
  ('SALT',    'Road salt',             'Bulk road salt (sample item).',                        'ton', true, true),
  ('FERT',    'Bulk fertilizer',       'Bulk fertilizer (sample item).',                       'ton', true, true);

-- Charge items -------------------------------------------------------------------
insert into public.charge_items (code, name, description, kind, calc_method, default_unit_code, taxable_default, is_sample) values
  ('HAUL-TON',  'Hauling per ton',   'Delivery charge per ton hauled (sample).', 'hauling',   'per_unit', 'ton',  false, true),
  ('HAUL-LOAD', 'Hauling per load',  'Delivery charge per load (sample).',       'hauling',   'per_unit', 'load', false, true),
  ('TRUCK-HR',  'Trucking per hour', 'Hourly truck and driver (sample).',        'service',   'per_unit', 'hour', false, true),
  ('FUEL-SC',   'Fuel surcharge',    'Percentage fuel surcharge (sample).',      'surcharge', 'percent_of_subtotal', null, false, true),
  ('DISC-PCT',  'Percentage discount','Percentage discount (sample).',           'discount',  'percent_of_subtotal', null, false, true),
  ('DISC-FLAT', 'Flat discount',     'Fixed-amount discount (sample).',          'discount',  'per_unit', 'each', false, true);

-- Placeholder rates on the standard list --------------------------------------------
insert into public.price_list_entries (price_list_id, material_id, unit_code, rate_cents, effective_from, notes)
select pl.id, m.id, m.default_unit_code, r.rate_cents, date '2026-01-01', 'SAMPLE placeholder rate — not a real price'
from public.price_lists pl
cross join (values
  ('GRV-53', 1000), ('GRV-8', 1200), ('SND-FILL', 800), ('QRY-2', 1500),
  ('DIRT-FL', 10000), ('TOPSOIL', 2500), ('SALT', 5000), ('FERT', 6000)
) as r(code, rate_cents)
join public.materials m on m.code = r.code
where pl.is_standard;

insert into public.price_list_entries (price_list_id, charge_item_id, unit_code, rate_cents, percent_bp, effective_from, notes)
select pl.id, ci.id, ci.default_unit_code, r.rate_cents, r.percent_bp, date '2026-01-01', 'SAMPLE placeholder rate — not a real price'
from public.price_lists pl
cross join (values
  ('HAUL-TON', 500, null::integer), ('HAUL-LOAD', 15000, null), ('TRUCK-HR', 10000, null), ('FUEL-SC', null, 500)
) as r(code, rate_cents, percent_bp)
join public.charge_items ci on ci.code = r.code
where pl.is_standard;

-- A customer-specific sample price list ---------------------------------------------
insert into public.price_lists (name, description, is_sample)
values ('Sample contractor rates', 'Example of a customer-specific price list (sample).', true);

insert into public.price_list_entries (price_list_id, material_id, unit_code, rate_cents, effective_from, notes)
select pl.id, m.id, 'ton', 900, date '2026-01-01', 'SAMPLE placeholder rate — not a real price'
from public.price_lists pl
join public.materials m on m.code = 'GRV-53'
where pl.name = 'Sample contractor rates';

-- Customers --------------------------------------------------------------------------
insert into public.customers (name, customer_type, email, phone, billing_line1, billing_city, billing_state,
  billing_postal_code, po_required, po_instructions, payment_terms, notes, is_sample, price_list_id)
values
  ('Lakeshore Paving Co.', 'commercial', 'office@lakeshore-paving.example', '(219) 555-0101',
   '100 Example Industrial Dr', 'Gary', 'IN', '46401', true, 'PO number required on every ticket.', 'Net 30',
   'Fictional sample customer.', true,
   (select id from public.price_lists where name = 'Sample contractor rates')),
  ('Prairie View Landscaping', 'commercial', 'ap@prairieview-landscape.example', '(219) 555-0102',
   '200 Sample Ave', 'Valparaiso', 'IN', '46383', false, '', 'Net 15',
   'Fictional sample customer.', true, null),
  ('Jordan & Casey Rivera', 'residential', 'rivera.family@example.com', '(219) 555-0103',
   '300 Placeholder Ln', 'Crown Point', 'IN', '46307', false, '', 'Due on delivery',
   'Fictional residential sample customer.', true, null),
  ('County Line Excavating', 'commercial', 'dispatch@countyline-ex.example', '(219) 555-0104',
   '400 Demo Rd', 'Merrillville', 'IN', '46410', true, 'Job number + PO on invoice.', 'Net 30',
   'Fictional sample customer.', true, null);

insert into public.customer_contacts (customer_id, name, title, email, phone, is_primary, is_billing)
select c.id, x.name, x.title, x.email, x.phone, x.is_primary, x.is_billing
from (values
  ('Lakeshore Paving Co.', 'Pat Morgan', 'Project manager', 'pat@lakeshore-paving.example', '(219) 555-0111', true, false),
  ('Lakeshore Paving Co.', 'Accounts Payable', 'Billing', 'ap@lakeshore-paving.example', '(219) 555-0112', false, true),
  ('Prairie View Landscaping', 'Sam Lee', 'Owner', 'sam@prairieview-landscape.example', '(219) 555-0121', true, true),
  ('Jordan & Casey Rivera', 'Jordan Rivera', '', 'rivera.family@example.com', '(219) 555-0103', true, true),
  ('County Line Excavating', 'Alex Novak', 'Superintendent', 'alex@countyline-ex.example', '(219) 555-0141', true, false)
) as x(customer, name, title, email, phone, is_primary, is_billing)
join public.customers c on c.name = x.customer;

insert into public.customer_sites (customer_id, label, line1, city, state, postal_code, directions)
select c.id, x.label, x.line1, x.city, 'IN', x.zip, x.directions
from (values
  ('Lakeshore Paving Co.', 'Route 30 parking lot job', '1500 Example Hwy', 'Merrillville', '46410', 'Enter from the east gate. Sample directions.'),
  ('Lakeshore Paving Co.', 'Yard', '100 Example Industrial Dr', 'Gary', '46401', ''),
  ('Prairie View Landscaping', 'Subdivision phase 2', '25 Sample Meadow Ct', 'Chesterton', '46304', 'Dump at the north end of the cul-de-sac.'),
  ('Jordan & Casey Rivera', 'Home', '300 Placeholder Ln', 'Crown Point', '46307', 'Driveway — watch for the mailbox.'),
  ('County Line Excavating', 'Pond excavation', '9000 Demo Rd', 'Hebron', '46341', 'Gravel access road; call before arrival.')
) as x(customer, label, line1, city, zip, directions)
join public.customers c on c.name = x.customer;
