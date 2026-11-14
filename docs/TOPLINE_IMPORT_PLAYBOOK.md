# Top Line import day: playbook (LR3)

How Top Line Trucking's own spreadsheets get into Taviron (LAUNCH §5, master plan §12 LR3): through the company import
(Settings → Import), with a preview and a review the owner approves before anything is created. Written 2026-11-14
after a dry run with fictional files shaped like a small aggregate hauler's real exports (`tests/fixtures/import/`).

Nothing in this playbook invents data. If a column is missing, we ask; if a value is unclear, the row is fixed in the
spreadsheet or left out, never guessed.

## 0. Before the day

- **Migration `20261120021000_import_contacts_checks`** must be applied to the database Top Line uses (it adds customer
  contacts and CDL endorsements, and makes staging refuse rows that approval would refuse). It ships with the next
  promotion (DEPLOYMENT §2c). Until it is applied, everything below works except contacts and endorsements; the
  contacts option then says "needs a database update that has not been installed yet".
- The owner signs in to Top Line's own company (owner role: imports need *Manage settings*). Taviron support does not
  import into a live company: the owner stages and approves (support visits cannot act as the owner, CLAUDE.md).
- Units of measure: Settings has the standard units (ton, load, cubic yard, hour, mile, day, each). If Top Line sells
  by another unit, add it under Materials → Units first.

## 1. When the files arrive (Claude, same day)

1. Save each file in the session scratchpad, never in the repository (it is real company data).
2. Excel workbooks (`.xlsx`): convert each sheet to CSV without changing values. Either the owner does
   *File → Save As → CSV UTF-8*, or Claude converts locally:
   `python3 -c "import csv,openpyxl,sys; ws=openpyxl.load_workbook(sys.argv[1],data_only=True)[sys.argv[2]]; w=csv.writer(open(sys.argv[3],'w',newline='',encoding='utf-8-sig')); [w.writerow(['' if v is None else (v.strftime('%Y-%m-%d') if hasattr(v,'strftime') else v) for v in r]) for r in ws.iter_rows(values_only=True)]" book.xlsx "Sheet1" out.csv`
   (dates come out as YYYY-MM-DD, so Excel date numbers never appear). Check that unit numbers and ZIP codes kept
   their leading zeros; if Excel stored them as numbers the zeros are already gone and we ask the owner.
3. Dry run every file with exactly the preview's checks (offline, nothing is sent or saved):
   `npx tsx scripts/import/dry-run.ts <customers|contacts|sites|materials|trucks|trailers|drivers> <file.csv>`
   It prints how each column is matched, the columns left out, what blank values become, and every row that needs
   fixing, by its spreadsheet row number.
4. Send the owner one short summary per file: rows that pass, rows that need fixing (row number and the plain reason),
   and the questions below, **one question at a time**, each with a recommendation (CLAUDE.md).

## 2. Which file goes where (import in this order)

Customers first: contacts and job sites are matched to customers **by exact name** (case and extra spaces ignored).

| Order | "The spreadsheet contains" | Needed columns | Useful columns | Notes |
| --- | --- | --- | --- | --- |
| 1 | Customers | Name | Type, Email, Phone, Billing address (+ line 2), City, State, ZIP, Payment terms, PO required, Tax exempt, Notes | Blank type → Commercial; blank PO required / Tax exempt → No. Customer numbers are assigned by Taviron (an "Acct #" column is left out; put it in Notes if the owner wants to keep it). |
| 2 | Customer contacts | Customer, Contact name (or First + Last name) | Title, Email, Phone, Billing contact (yes/no), Notes | The same customer list can be imported again as contacts when it has a "Contact" column: then the row's phone and email go to the contact. Imported contacts are never "primary"; the first contact is used until someone picks one on the customer page. |
| 3 | Job sites | Customer, Street address | Site name, Address line 2, City, State, ZIP, Directions / gate code | Blank site name → the street address; **blank state → IN** (shown in the preview). Rows for a customer that is not in Taviron need fixing. |
| 4 | Materials | Name, Unit | Code, Description, Taxable | Blank taxable → **Yes** (shown in the preview; ask the owner, see §4). Prices are not imported here (see §5). |
| 5 | Trucks | Unit number, Truck type | Year, Make, Model, VIN, License plate, Plate state, Notes | Types: single-axle, tandem, tri-axle, quad-axle dump, tractor, straight truck, other. "10 wheeler"-style names are not guessed: ask. |
| 6 | Trailers | Unit number, Trailer type | Year, Make, Model, VIN, License plate, Plate state, Notes | Types: end dump, belly dump, side dump, live floor, pup, dry van, reefer, flatbed, step deck, lowboy, other. |
| 7 | Drivers | Name (or First + Last name) | Employee number, Phone, Hire date, CDL class, CDL state, CDL expires, CDL endorsements, Medical card expires, Notes | CDL and medical dates are recorded as entered and **unverified** until someone checks them on the driver. A "CDL #" (licence number) column is left out on purpose. |

Not imported: employees and their roles (people are invited from People so each signs in with their own account and
two-step verification), equipment status, registration or inspection dates, history (orders, tickets, invoices).

### What the reader accepts (all entities)

- Excel "CSV UTF-8", Excel's older "CSV (Comma delimited)" (Windows encoding: é and ’ stay correct), Google Sheets CSV,
  "Unicode text" (UTF-16, tab-separated), semicolon files, Excel's `sep=` line, Windows / Mac / Unix line ends.
- A title row (or two) above the column names, blank rows anywhere, extra columns (shown as "Not imported").
  **Row numbers in the preview and review are the spreadsheet's own rows.**
- Column names as people write them: "Cust Name", "Phone #", "E-mail", "Emp No.", "CDL Exp Date", "Med Card Exp.",
  "DOT Physical Exp", "Gate Code / Notes", "U/M", "Item #". A "#" means number, so "Customer #" or "CDL #" is never
  taken for the name or the CDL class. Every match can be changed in the "Match the columns" step.
- Values: spaces trimmed (also non-breaking spaces); "N/A", "-", "none", "TBD" in a date, yes/no, choice, email or phone
  column count as blank; yes/no as Y, X, true, 1, required; dates as 11/3/2026, 11/3/26, 2026-11-03, 3-Nov-26,
  Nov 3, 2026, with or without a time (month before day; a two-digit year is this century unless that is more than
  30 years ahead, so 5/1/98 is 1998); states by code or name ("Indiana" → IN); US phone numbers shown as
  (219) 555-0142 (extensions kept); VINs upper-cased; unit and employee numbers kept exactly, leading zeros included.

### What needs fixing (the row is never imported; the reason is shown on the row)

Excel errors in a cell (#N/A, #REF!), numbers Excel rounded (5.55E+09), Excel date numbers (46329) instead of dates,
dates that do not exist (13/1/2027), 4-digit ZIP codes (a dropped leading zero), two emails or phone numbers in one cell,
VINs that are not 17 characters (I, O and Q never appear), unknown truck or trailer types or units, codes with spaces,
values longer than the record allows, a CDL expiry or endorsements without a CDL class, a customer name that matches no
customer (or two), and duplicates: of an existing record ("Possible duplicate") or of an earlier row in the same file
("Same as row N of this file").

## 3. Import day, step by step (owner, with Claude on the call or in the chat)

For each file, in the order of §2:

1. Settings → **Import** → "The spreadsheet contains" → choose the kind → choose the CSV file.
2. **Match the columns**: check each column's match (the required ones say "required"); set anything wrong to the right
   field or to "Do not import". The line "Not imported: …" lists the columns left out.
3. Read the **preview**: the counts ("rows · pass the first checks · need fixing"), "Not in this file, so every record
   gets: …", and the rows that need fixing. Grey values are what a blank cell becomes.
4. Fix rows in the spreadsheet when it is quicker, or carry on: rows that need fixing are simply not imported and can be
   imported later from a corrected file.
5. **Check and send to review**. Nothing is created yet. The review shows every row with its checks; "Possible
   duplicate" rows are skipped unless the owner chooses "Import it" (only where two records may share a name, such as
   customers and drivers without an employee number). Any ready row can be skipped with "Skip it".
6. Tick "I reviewed the rows and the decisions above." → **Approve and create N**. All rows are created at once, or
   none (the page says which row stopped it, and nothing is created).
7. Spot-check two records on their own pages (a customer and its contacts and sites; a driver's CDL and medical card).

**Undo:** on the import's page, "Undo this import" with a reason makes every record it created inactive (never deleted;
history keeps them; they can be reactivated one by one). Undo the dependent imports first (contacts and sites before
their customers). Settings → Import lists every import with its status.

## 4. Questions to ask the owner when a column is missing or unclear (one at a time)

Ask only what the file leaves open; each with a recommendation.

- **Customers without a type column:** "Are any of these homeowners (residential) rather than businesses?"
  Recommend: import all as commercial and change the few residential ones on their page.
- **Materials without a taxable column:** "Is any material not taxable (for example sold to tax-exempt customers only)?"
  Recommend: add a Taxable column with yes/no before importing, since the blank default is *taxable*.
- **Customer list with a "Contact" column:** "Should the phone and email in this list belong to the customer, the
  contact, or both?" Recommend: both (import the file as customers, then as contacts).
- **Two emails or phones in one cell:** "Which one is the main address for invoices?" Recommend: keep the billing one,
  move the other to Notes or to a contact.
- **Truck types written another way ("10 wheeler", "triple"):** "Which Taviron type is each of these?" Never guessed.
- **Unit numbers or ZIP codes that lost leading zeros:** "Is truck 7 really 007?" Recommend: retype the column as Text.
- **Drivers without employee numbers:** fine; duplicates are then checked by name. "Do two drivers share a name?"
- **Job sites without a state:** "Are all these sites in Indiana?" (the blank default is IN).
- **Dates that could be day/month (European order):** "Is 03/11/2026 March 11 or 3 November?" The reader uses US order.
- **Inactive drivers, sold trucks, closed customers in the list:** "Leave them out, or import them and make them
  inactive?" Recommend: leave them out (filter the rows away, or "Skip it" in the review).

## 5. Rates and open orders (built to match the files once they arrive)

There is **no rates or orders import yet**, on purpose: we do not invent a format before seeing Top Line's files, and
prices and orders are financial records (CLAUDE.md, security first: pricing changes need *Edit pricing* and are
reviewed). Options, decided with the owner once the files are here:

### Rates / price lists

Where they live: Materials → **Price lists** (`/materials?tab=prices`). Every company has one "Standard rates" list;
customer-specific lists are added there and chosen on the customer. Each entry is a material or charge, a unit, a rate
per unit (or a percentage for charges) and an effective date; changing a rate keeps the history and never changes a
saved quote.

- **Few rates (up to a few dozen):** enter them through the price list screens. Fastest and fully reviewed; no new
  code. Recommended unless the file is long.
- **A long rate sheet:** a price-list import can be built to the file's real shape, through the same staging, review
  and approval as the other imports, behind *Edit pricing*, audited, and security-reviewed before it ships. What we
  need to see in the file to build it:
  - which price list each rate belongs to (standard, or a customer's own);
  - the material (or haul charge) by the same name or code as in the materials import;
  - the unit (ton, load, cubic yard, hour, …) and the rate as a money amount per unit;
  - the date the rate starts (and ends, if it is a past rate);
  - whether a rate is for hauling only, material only, or both (aggregate rate sheets often mix them);
  - zones, minimums, fuel surcharges or detention, if they appear (each is a separate rule, never folded into a rate).
- A materials file with a price column (like `Price/Ton` in the fixtures) imports the materials and leaves the price
  column out ("Not imported"); the prices are then entered or imported as above.

### Open orders

Where they live: Orders → **New order** (`/orders/new`): customer, job site, material, quantity and unit, dates, and
loads. Recommended for the first weeks: enter Top Line's open orders by hand (usually a handful on any day), which
also trains the office on the screen they will use daily. An open-orders import would only be considered for a long
list, and needs to see: the customer and job site (matching the imported names), material, quantity and unit, the
requested date or date range, the agreed price (from the price list or the order's own), PO number, and status. Orders
from an import would be created as drafts for a person to confirm, never dispatched or invoiced automatically.

## 6. After the import

- Settings → Import shows each import with its counts. The company audit log records "Spreadsheet staged / approved /
  undone" with who did it.
- Drivers' imported credentials show as unverified: the owner or office checks each card and marks it verified on the
  driver page.
- Record in LAUNCH §5 and the master plan §12 LR3 row: files received, per file the rows imported / skipped / fixed,
  and the date. Real file contents stay out of the repository.

## 7. How this was tested (2026-11-14)

- Fixtures: `tests/fixtures/import/` (fictional names marked "(test)"): `customers.csv` (BOM, CRLF, title rows, blank
  rows, duplicates, trailing and non-breaking spaces, state names, phone formats, two emails in a cell, a 4-digit ZIP,
  `#N/A`), `customers-windows1252.csv`, `contacts.csv` (first/last names), `job-sites.csv` (multi-line gate notes),
  `materials.csv` (units as written, a price column, a code with a space), `trucks.csv` (leading zeros, lower-case and
  short VINs, "Indiana", unknown type, future year), `trailers-utf16.txt` (UTF-16, tab-separated), `drivers.csv` (first
  and last names, two-digit years, 3-Nov-27, an Excel date number, Non-CDL, endorsements, a "CDL #" column).
- Tests: `tests/unit/import-fixtures.test.ts` (reading and checks), `tests/db/import-fixtures.test.ts` (staging,
  duplicates, approval, undo, staging checks, platform revert guard, rollback), `tests/e2e/import-dry-run.spec.ts`
  (the owner's path in the browser on a production build).
