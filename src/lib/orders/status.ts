import type { OrderStatus } from "@/server/data/types";

export const ORDER_STATUSES: OrderStatus[] = [
  "draft",
  "confirmed",
  "scheduled",
  "dispatched",
  "in_progress",
  "partially_completed",
  "completed",
  "on_hold",
  "canceled",
];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  draft: "Draft",
  confirmed: "Confirmed",
  scheduled: "Scheduled",
  dispatched: "Dispatched",
  in_progress: "In progress",
  partially_completed: "Partially completed",
  completed: "Completed",
  on_hold: "On hold",
  canceled: "Canceled",
};
