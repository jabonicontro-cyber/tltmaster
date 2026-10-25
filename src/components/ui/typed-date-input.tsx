"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/cn";
import { isoToTyped, parseTypedDate } from "@/lib/dates";

/**
 * A date people can type (MM/DD/YYYY: select all, edit digits, paste) with the browser's own calendar as the
 * alternative. The text field is the control; a hidden native date input only provides the calendar, and a hidden
 * field submits "YYYY-MM-DD" under `name`. Invalid or incomplete text is never converted to another date: the field
 * says what is wrong (on blur, or when the form is submitted) and blocks submission through the browser's validity.
 * The server validates again.
 */
export function TypedDateInput({
  name, label, defaultValue = "", min = "2000-01-01", max = "2099-12-31", required = false, extraError = null, onValueChange, className,
}: {
  name: string;
  /** Used for the field's accessible name and the calendar button. */
  label: string;
  /** "YYYY-MM-DD". */
  defaultValue?: string;
  min?: string;
  max?: string;
  required?: boolean;
  /** A problem found by the surrounding form (for example "To" before "From"); shown and blocks submission. */
  extraError?: string | null;
  onValueChange?: (iso: string | null) => void;
  className?: string;
}) {
  const id = useId();
  const textRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(isoToTyped(defaultValue));
  const [shown, setShown] = useState(false);

  const parsed = parseTypedDate(text, min, max);
  const iso = parsed.ok ? parsed.iso : "";
  const problem = parsed.ok ? extraError : parsed.empty && !required ? null : parsed.error;

  // The browser's validity drives submission; the message below is what people read.
  useEffect(() => {
    textRef.current?.setCustomValidity(problem ?? "");
  }, [problem]);

  useEffect(() => {
    onValueChange?.(iso || null);
  }, [iso, onValueChange]);

  function openCalendar() {
    const el = pickerRef.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
      el.click();
    }
  }

  return (
    <span className={cn("relative inline-flex flex-col", className)}>
      <span className="relative inline-flex items-center">
        <input
          ref={textRef}
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder="MM/DD/YYYY"
          aria-label={label}
          aria-invalid={shown && problem ? true : undefined}
          aria-describedby={shown && problem ? `${id}-error` : undefined}
          value={text}
          maxLength={10}
          onChange={(e) => {
            setText(e.target.value);
            setShown(false);
          }}
          onBlur={() => {
            const p = parseTypedDate(text, min, max);
            // A complete, valid date is shown in one format; anything else is left exactly as typed.
            if (p.ok) setText(isoToTyped(p.iso));
            setShown(true);
          }}
          onInvalid={() => setShown(true)}
          className="h-10 w-[9.5rem] rounded-control border border-line bg-card pr-10 pl-2.5 text-[15px] text-ink tabular placeholder:text-muted/70 aria-invalid:border-critical"
        />
        <button
          type="button"
          onClick={openCalendar}
          aria-label={`Open calendar for ${label}`}
          className="absolute right-1 inline-flex size-8 items-center justify-center rounded text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-strong"
        >
          <CalendarDays className="size-4" aria-hidden />
        </button>
        {/* The calendar only: not focusable, not submitted. */}
        <input
          ref={pickerRef}
          type="date"
          tabIndex={-1}
          aria-hidden
          min={min}
          max={max}
          value={iso}
          onChange={(e) => {
            if (!e.target.value) return;
            setText(isoToTyped(e.target.value));
            setShown(true);
            textRef.current?.focus();
          }}
          className="pointer-events-none absolute right-1 bottom-0 size-px opacity-0"
        />
        <input type="hidden" name={name} value={iso} />
      </span>
      {shown && problem ? (
        // Below the field without moving it, so a row of fields and buttons stays aligned.
        <span id={`${id}-error`} role="alert" className="absolute top-full left-0 mt-1 w-max max-w-[16rem] text-xs font-normal text-critical">{problem}</span>
      ) : null}
    </span>
  );
}

/** A From–To pair: both required, and To may not be before From. */
export function DateRangeFields({ from, to, min, max }: { from: string; to: string; min?: string; max?: string }) {
  const [start, setStart] = useState<string | null>(from || null);
  const [end, setEnd] = useState<string | null>(to || null);
  const order = start && end && end < start ? "To must be on or after From." : null;
  return (
    <>
      <span className="text-sm font-semibold">
        <span className="mb-1 block">From</span>
        <TypedDateInput name="from" label="From" defaultValue={from} min={min} max={max} required onValueChange={setStart} />
      </span>
      <span className="text-sm font-semibold">
        <span className="mb-1 block">To</span>
        <TypedDateInput name="to" label="To" defaultValue={to} min={min} max={max} required extraError={order} onValueChange={setEnd} />
      </span>
    </>
  );
}
