/**
 * Payroll exports (B27). A neutral, documented CSV of approved gross earnings per driver (summary) or per ticket
 * (detail). It is NOT a QuickBooks or payroll-provider import format: those differ between QuickBooks Desktop, QuickBooks
 * Online and third-party payroll services, and Taviron does not claim compatibility until a format has been tested
 * against the company's actual destination. Taviron calculates gross earnings only — no taxes, withholding or net pay.
 */

export interface ExportDriverRow {
  driver_name: string;
  employee_number: string;
  tickets: number;
  earnings_cents: number;
  adjustments_cents: number;
  total_cents: number;
}

export interface ExportTicketRow {
  driver_name: string;
  employee_number: string;
  ticket_number: string;
  delivered_on: string;
  quantity: string;
  unit_code: string;
  rule: string;
  breakdown: string;
  amount_cents: number;
}

const money = (cents: number) => {
  const neg = cents < 0;
  const a = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};

/** One CSV field: quoted when needed; a leading = + - @ is neutralised so spreadsheets never run it as a formula. */
export function csvField(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const line = (fields: Array<string | number>) => fields.map(csvField).join(",");

export function summaryCsv(period: { starts_on: string; ends_on: string }, rows: readonly ExportDriverRow[]): string {
  const out = [line(["period_start", "period_end", "driver", "employee_number", "earnings_item", "tickets", "ticket_earnings", "adjustments", "gross_earnings"])];
  for (const r of rows) {
    out.push(line([period.starts_on, period.ends_on, r.driver_name, r.employee_number, "Delivery ticket earnings", r.tickets, money(r.earnings_cents), money(r.adjustments_cents), money(r.total_cents)]));
  }
  return out.join("\n") + "\n";
}

export function detailCsv(period: { starts_on: string; ends_on: string }, rows: readonly ExportTicketRow[]): string {
  const out = [line(["period_start", "period_end", "driver", "employee_number", "ticket", "delivered_on", "quantity", "unit", "pay_rule", "calculation", "amount"])];
  for (const r of rows) {
    out.push(line([period.starts_on, period.ends_on, r.driver_name, r.employee_number, r.ticket_number, r.delivered_on, r.quantity, r.unit_code, r.rule, r.breakdown, money(r.amount_cents)]));
  }
  return out.join("\n") + "\n";
}

export const centsText = money;
