"use client";

import { useId, useState } from "react";
import { paperworkCost, type PaperworkInput } from "@/lib/site/calculator";

// The visitor's own numbers in, their own estimate out. Nothing is sent anywhere and nothing is pre-filled: Taviron
// has no measured figures to offer yet, so the calculator never suggests what a company "should" spend or save.

const FIELDS: Array<{ key: keyof PaperworkInput; label: string; hint: string; step: string; max: number }> = [
  { key: "trucks", label: "Trucks hauling on a typical day", hint: "Your own and hired.", step: "1", max: 2000 },
  { key: "loadsPerTruck", label: "Loads per truck per day", hint: "One delivery ticket each.", step: "0.5", max: 60 },
  { key: "daysPerWeek", label: "Working days per week", hint: "", step: "0.5", max: 7 },
  { key: "hourlyCost", label: "Office cost per hour ($)", hint: "Optional: wage plus taxes and benefits.", step: "0.5", max: 1000 },
  { key: "minutesPerTicket", label: "Office minutes per ticket", hint: "Collecting, typing, checking against the order and chasing missing ones.", step: "0.5", max: 120 },
];

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function PaperworkCalculator() {
  const id = useId();
  const [values, setValues] = useState<Record<keyof PaperworkInput, string>>({ trucks: "", loadsPerTruck: "", daysPerWeek: "", minutesPerTicket: "", hourlyCost: "" });
  const result = paperworkCost(values);
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_0.9fr]">
      <form className="grid gap-5 sm:grid-cols-2" aria-label="Your numbers" onSubmit={(e) => e.preventDefault()}>
        {FIELDS.map((f) => (
          <div key={f.key} className={f.key === "minutesPerTicket" ? "sm:col-span-2" : undefined}>
            <label htmlFor={`${id}-${f.key}`} className="block text-sm font-semibold text-cloud">{f.label}</label>
            <input
              id={`${id}-${f.key}`}
              type="number"
              inputMode="decimal"
              min="0"
              max={f.max}
              step={f.step}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              aria-describedby={f.hint ? `${id}-${f.key}-hint` : undefined}
              className="mt-2 h-12 w-full rounded-xl border border-silver/25 bg-navy px-4 text-base text-cloud tabular-nums outline-none focus:border-electric focus:ring-2 focus:ring-electric/30"
            />
            {f.hint ? <p id={`${id}-${f.key}-hint`} className="mt-1.5 text-sm text-silver/80">{f.hint}</p> : null}
          </div>
        ))}
      </form>

      <div className="rounded-2xl border border-silver/12 bg-navy-2 p-6 sm:p-8" aria-live="polite">
        <h2 className="text-sm font-semibold text-silver">Your estimate</h2>
        {result ? (
          <dl className="mt-5 grid gap-6">
            <div>
              <dt className="text-sm text-silver">Delivery tickets a week</dt>
              <dd className="site-title mt-1 text-4xl font-bold text-cloud tabular-nums">{nf.format(result.ticketsPerWeek)}</dd>
            </div>
            <div>
              <dt className="text-sm text-silver">Office hours a week on tickets</dt>
              <dd className="site-title mt-1 text-4xl font-bold text-cloud tabular-nums">{nf.format(result.hoursPerWeek)}</dd>
            </div>
            {result.costPerYear !== null ? (
              <div>
                <dt className="text-sm text-silver">Cost a year</dt>
                <dd className="site-title mt-1 text-4xl font-bold text-electric tabular-nums">{usd.format(result.costPerYear)}</dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="mt-5 text-[15px] leading-relaxed text-silver">Enter your trucks, loads, days and minutes per ticket to see what ticket paperwork takes today.</p>
        )}
        <p className="mt-6 border-t border-silver/12 pt-4 text-sm leading-relaxed text-silver/80">
          An estimate from the numbers you entered, not a promise of savings. Nothing you type leaves this page.
        </p>
      </div>
    </div>
  );
}
