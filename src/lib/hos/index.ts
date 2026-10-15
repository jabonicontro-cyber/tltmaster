/**
 * Hours of service (HOS) in dispatch.
 *
 * Taviron has no ELD or driver-log source yet (master plan §9 Q20: the owner chooses one). Until a provider is
 * connected, no assignment is ever presented as HOS-verified: every approval of a Smart Dispatch or Plan the day
 * proposal needs the dispatcher's explicit confirmation that they checked each driver's hours, enforced on the server
 * and recorded on the assignment. Taviron never invents remaining drive time or duty-cycle rules.
 *
 * A provider plugs in here: it answers per driver and time whether hours are known and sufficient. Only a provider
 * whose data is current may verify; stale or missing data falls back to the dispatcher's confirmation, and a
 * verified shortfall becomes a hard block in eligibility (not built until a source exists).
 */
export type HosSource = "none";

export interface HosProvider {
  readonly source: HosSource;
  /** True only when this provider has current data for the driver at that time (never true for "none"). */
  verified(driverId: string, at: string): boolean;
}

export const NO_HOS_PROVIDER: HosProvider = { source: "none", verified: () => false };

/** The configured provider. Today always "none". */
export function hosProvider(): HosProvider {
  return NO_HOS_PROVIDER;
}

/** What the dispatcher confirms before approving a proposal (shown in the dialog and recorded on the assignment). */
export const HOS_CONFIRMATION = "I checked that each driver has the hours of service for these loads. Taviron has no ELD or driver-log data, so it did not check them.";

export const HOS_REQUIRED_MESSAGE = "Confirm that you checked each driver's hours of service first — Taviron has no ELD or driver-log data.";

/** The assignment note: what was approved, and that hours were confirmed by a person, not verified by Taviron. */
export function approvalNote(what: string, confirmed: boolean): string {
  return (confirmed ? `${what}; hours of service confirmed by the dispatcher (not verified by Taviron)` : what).slice(0, 500);
}

/** Whether an approval may proceed: a provider-verified driver, or the dispatcher's confirmation. */
export function hosApprovalAllowed(provider: HosProvider, driverIds: string[], at: string, confirmed: boolean): boolean {
  return confirmed || driverIds.every((d) => provider.verified(d, at));
}
