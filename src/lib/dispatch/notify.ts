/**
 * How drivers learn about an assignment, in plain words for the dispatcher (first-day finding 2026-11-09). The database
 * tells a driver with a Taviron sign-in on My Day when a load is assigned (private.alerts_from_new_assignments); a
 * driver without a sign-in hears nothing from Taviron, so the dispatcher calls them. Nothing is sent from here.
 */
export interface NotifiedDriver {
  name: string;
  /** The driver has an active Taviron sign-in (drivers.user_id, account not deactivated). */
  hasSignIn: boolean;
}

const list = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** "Marco Delgado will see it in My Day." / "Marco Delgado has no Taviron sign-in: call them." (several: grouped). */
export function driverNoticeText(drivers: NotifiedDriver[]): string {
  const seen = new Map<string, boolean>();
  for (const d of drivers) seen.set(d.name, (seen.get(d.name) ?? false) || d.hasSignIn);
  const told = [...seen].filter(([, s]) => s).map(([n]) => n);
  const call = [...seen].filter(([, s]) => !s).map(([n]) => n);
  // "it" for one load, "them" when the drivers told have more than one between them.
  const loads = drivers.filter((d) => told.includes(d.name)).length > 1 ? "them" : "it";
  const out: string[] = [];
  if (told.length) out.push(`${list(told)} will see ${loads} in My Day.`);
  if (call.length) out.push(`${list(call)} ${call.length === 1 ? "has" : "have"} no Taviron sign-in: call ${call.length === 1 ? "them" : "each of them"}.`);
  return out.join(" ");
}
