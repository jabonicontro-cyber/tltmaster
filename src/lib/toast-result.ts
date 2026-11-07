"use client";

import { toast } from "sonner";
import { isApprovalSent } from "@/lib/support-requests";

/** Show a failed action's message; a change sent to an owner for approval (SA2) is information, not an error. */
export function toastActionError(message: string) {
  if (isApprovalSent(message)) toast.info(message);
  else toast.error(message);
}
