// Shift offers (B102, migration 20261120004700): labels shared by the Schedule, My Day and Settings.

export type OfferMode = "request" | "first_accept" | "offer";
export type OfferAudience = "drivers" | "shop" | "everyone";
export type OfferStatus = "open" | "pending" | "filled" | "canceled";
export type ResponseStatus = "requested" | "accepted" | "approved" | "declined" | "withdrawn" | "not_chosen";

export const OFFER_MODES: Array<{ value: OfferMode; label: string; description: string }> = [
  { value: "request", label: "People ask, a planner approves", description: "Qualified people ask for the shift; someone who plans schedules chooses who gets it." },
  { value: "first_accept", label: "First to accept gets it", description: "The first qualified person to accept gets the shift at once; planners are notified." },
  { value: "offer", label: "Offer to chosen people, a planner confirms", description: "The planner picks who to offer it to; the first of them to accept holds it until a planner confirms." },
];
export const modeLabel = (m: OfferMode) => OFFER_MODES.find((x) => x.value === m)?.label ?? m;

export const AUDIENCE_LABEL: Record<OfferAudience, string> = { drivers: "Drivers", shop: "Shop", everyone: "Everyone" };

export const OFFER_STATUS: Record<OfferStatus, { label: string; tone: "amber" | "green" | "gray" | "blue" }> = {
  open: { label: "Open", tone: "blue" },
  pending: { label: "Waiting for confirmation", tone: "amber" },
  filled: { label: "Filled", tone: "green" },
  canceled: { label: "Withdrawn", tone: "gray" },
};

export const RESPONSE_LABEL: Record<ResponseStatus, string> = {
  requested: "Asked",
  accepted: "Accepted",
  approved: "Got the shift",
  declined: "Declined",
  withdrawn: "Withdrew",
  not_chosen: "Not chosen",
};

/** What a person's button says for an open offer in this mode. */
export const respondLabel = (m: OfferMode) => (m === "request" ? "Ask for this shift" : "Accept shift");
