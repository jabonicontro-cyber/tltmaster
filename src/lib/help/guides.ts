import type { Permission } from "@/lib/permissions";

/**
 * Guided how-tos (B65). Each step points at a page and, optionally, a control marked in the code with a stable
 * `data-guide="…"` attribute (never a CSS selector). The guide only highlights and explains: the person clicks and
 * saves everything themselves, so nothing is created, assigned or sent because a guide is running.
 */
export interface GuideStep {
  /** The page this step happens on (exact path, or a prefix ending in "/*"). */
  route: string;
  /** Where to send the person when they are elsewhere (defaults to `route`). */
  href?: string;
  /** data-guide value of the control to highlight; omitted for a step that only explains. */
  anchor?: string;
  title: string;
  body: string;
}

export interface Guide {
  id: string;
  title: string;
  summary: string;
  /** Who may follow it (any of these); the start button is hidden otherwise. */
  permissions: Permission[];
  /** The help article that explains the same workflow. */
  article?: string;
  steps: GuideStep[];
}

export const GUIDES: Guide[] = [
  {
    id: "create-customer",
    title: "Create a customer",
    summary: "Add a customer so you can quote and take orders for them.",
    permissions: ["customers.edit"],
    article: "customers",
    steps: [
      { route: "/customers", anchor: "customers-new", title: "Start a new customer", body: "Select New customer. Nothing is saved until you create it on the next page." },
      { route: "/customers/new", anchor: "customer-name", title: "Name and relationship", body: "Enter the customer's name. Choose Prospect if they have not ordered yet; they become a Customer with their first order or a won opportunity." },
      { route: "/customers/new", anchor: "customer-create", title: "Create it", body: "Check the details, then select Create customer. If a similar customer already exists, Taviron asks you to confirm before creating another." },
    ],
  },
  {
    id: "create-order",
    title: "Create an order",
    summary: "Take a direct order (or convert an accepted quote) so dispatch can schedule it.",
    permissions: ["orders.edit"],
    article: "orders",
    steps: [
      { route: "/orders", anchor: "orders-new", title: "Start an order", body: "Select New order. Orders from an accepted quote are created from the quote instead, with its prices." },
      { route: "/orders/new", title: "Customer, site and lines", body: "Choose the customer, the job site and what is delivered. The order stays a draft until you confirm it, so you can save and come back." },
      { route: "/orders/*", title: "Confirm and schedule", body: "On the order page, confirm it and set the delivery dates. Confirmed orders appear on the dispatch board for scheduling." },
    ],
  },
  {
    id: "assign-load",
    title: "Assign a truck and driver",
    summary: "Put a truck and driver on an unassigned load, with or without Smart Dispatch.",
    permissions: ["dispatch.edit"],
    article: "dispatch-board",
    steps: [
      { route: "/dispatch", anchor: "dispatch-board", title: "Find the open loads", body: "Unassigned loads for the day are on the board. Change the date to look ahead." },
      { route: "/dispatch", title: "Use a proposal or choose yourself", body: "Smart Dispatch proposes a truck and driver with its reasons and what it left out. Approving a proposal assigns it only after the database checks it again; nothing is assigned until you approve or assign." },
    ],
  },
  {
    id: "add-truck",
    title: "Add a truck",
    summary: "Add a truck to the fleet so it can be dispatched and maintained.",
    permissions: ["fleet.edit"],
    article: "fleet-trucks",
    steps: [
      { route: "/fleet/trucks", anchor: "trucks-add", title: "Start a new truck", body: "Select Add truck." },
      { route: "/fleet/trucks/new", anchor: "truck-unit", title: "Unit number and type", body: "Enter the unit number as painted on the truck and choose its type. Capacities can wait until they are confirmed." },
      { route: "/fleet/trucks/new", title: "Save", body: "Select Add truck at the bottom to save it. Record registration and insurance on the truck's page so expiry warnings work." },
    ],
  },
];

export const guideById = (id: string) => GUIDES.find((g) => g.id === id);
