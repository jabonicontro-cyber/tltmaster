// End-of-day owner summary (master plan B97): the day's measured figures as a short plain-text email. Counts only; no
// names, customers or amounts leave the app in it. Zero lines are left out except the first, so it stays short.

export interface DailySummary {
  day: string;
  loads: number;
  delivered: number;
  without_truck: number;
  missing_tickets: number;
  to_review: number;
  trucks_down: number;
  open_reports: number;
  tomorrow_loads: number;
  tomorrow_without_truck: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function summaryLines(s: DailySummary): string[] {
  return [
    `Loads today: ${s.delivered} of ${s.loads} delivered with a ticket`,
    s.missing_tickets ? `${plural(s.missing_tickets, "assigned load has", "assigned loads have")} no ticket yet` : "",
    s.without_truck ? `${plural(s.without_truck, "load", "loads")} today never got a truck` : "",
    s.to_review ? `${plural(s.to_review, "ticket is", "tickets are")} waiting for review` : "",
    s.trucks_down ? `${plural(s.trucks_down, "truck is", "trucks are")} out of service` : "",
    s.open_reports ? `${plural(s.open_reports, "driver report is", "driver reports are")} still open` : "",
    `Tomorrow: ${plural(s.tomorrow_loads, "load", "loads")}${s.tomorrow_without_truck ? `, ${s.tomorrow_without_truck} without a truck` : ""}`,
  ].filter(Boolean);
}

export function summaryEmail(company: string, s: DailySummary, appUrl: string): { subject: string; text: string } {
  const date = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${s.day}T00:00:00Z`));
  return {
    subject: `${company}: end of day, ${date}`,
    text: [
      `End of day for ${company}, ${date}.`,
      "",
      ...summaryLines(s).map((l) => `- ${l}`),
      "",
      `Open the Command Center: ${appUrl.replace(/\/$/, "")}/command-center`,
      "",
      "Figures are read from Taviron's records when this was sent. Turn this email off in Settings → Email.",
    ].join("\n"),
  };
}
