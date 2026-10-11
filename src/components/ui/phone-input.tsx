"use client";

import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "@/lib/cn";
import { backspaceOverFormatting, caretAfterFormat, formatPhone } from "@/lib/phone";
import { Input } from "./form";

type Props = Omit<ComponentProps<"input">, "value" | "defaultValue" | "onChange" | "type"> & {
  /** Controlled value (optional); without it the field keeps its own state like a plain input. */
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Use the caller's own classes instead of the app's input style (the public website form). */
  bare?: boolean;
};

/**
 * A phone field that formats US numbers as they are typed — (123) 456-7890 —
 * without fighting the person: pasting, editing in the middle and backspacing
 * over ")", " " or "-" keep the caret where it belongs. "+" numbers are left
 * as typed; extensions are kept. Submits the formatted text under `name`.
 */
export function PhoneInput({ value, defaultValue, onValueChange, onKeyDown, className, bare = false, ...props }: Props) {
  const [own, setOwn] = useState(() => formatPhone(defaultValue ?? ""));
  const shown = value !== undefined ? formatPhone(value) : own;
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (caret.current !== null && ref.current && document.activeElement === ref.current) {
      ref.current.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  });

  const commit = (raw: string, at: number) => {
    const next = formatPhone(raw);
    caret.current = caretAfterFormat(raw, at, next);
    if (value === undefined) setOwn(next);
    onValueChange?.(next);
  };

  const Field = bare ? "input" : Input;
  return (
    <Field
      {...props}
      ref={ref}
      type="tel"
      inputMode="tel"
      autoComplete={props.autoComplete ?? "tel"}
      className={cn("tabular-nums", className)}
      value={shown}
      onChange={(e) => commit(e.target.value, e.target.selectionStart ?? e.target.value.length)}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        const el = e.currentTarget;
        if (e.key === "Backspace" && !e.defaultPrevented && el.selectionStart === el.selectionEnd) {
          const r = backspaceOverFormatting(el.value, el.selectionStart ?? 0);
          if (r) {
            e.preventDefault();
            commit(r.value, r.caret);
          }
        }
      }}
    />
  );
}
