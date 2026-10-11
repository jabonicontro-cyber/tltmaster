"use client";

import type { ComponentProps, FocusEvent } from "react";
import { Input } from "./form";
import { normalizeTypedDate } from "@/lib/dates";

/**
 * The one date field used across the app (N15). A native date input, so
 * calendar selection and typing behave the same, with two fixes for what
 * people actually type:
 *  - max limits the year to four digits (otherwise "10/15/26" typed into the
 *    year segment becomes year 101526);
 *  - a two-digit year ("26") becomes 2026 when the field loses focus,
 *    instead of being saved as the year 0026.
 * The value is always "YYYY-MM-DD" (a calendar date, no time zone), so what
 * is shown is what is saved. The server validates the range again.
 */
export function DateInput({ min = "2000-01-01", max = "2099-12-31", onBlur, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <Input
      type="date"
      min={min}
      max={max}
      {...props}
      onBlur={(e: FocusEvent<HTMLInputElement>) => {
        const el = e.currentTarget;
        // The browser commits a half-typed year after the blur event, so fix it on the next tick.
        setTimeout(() => {
          const fixed = normalizeTypedDate(el.value);
          if (fixed === el.value) return;
          // Set it the way a user would, so controlled and uncontrolled forms both see the change.
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          setter?.call(el, fixed);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }, 0);
        onBlur?.(e);
      }}
    />
  );
}
