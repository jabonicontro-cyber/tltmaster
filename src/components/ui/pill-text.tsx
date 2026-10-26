import { Children, type ReactNode } from "react";

// Pill centring (owner 2026-10-26, a rule for every pill and button): the words sit in a span trimmed to the capitals
// and the baseline (the pill-text class in globals.css), inside a fixed-height flex row with items-center.

/** Runs of text become one trimmed span each ("3", " loads" stay one span); icons and elements pass through. */
export function pillChildren(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  let run: Array<string | number> = [];
  const flush = () => {
    if (run.length) out.push(<span key={`t${out.length}`} className="pill-text">{run.join("")}</span>);
    run = [];
  };
  for (const c of Children.toArray(children)) {
    if (typeof c === "string" || typeof c === "number") run.push(c);
    else {
      flush();
      out.push(c);
    }
  }
  flush();
  return out;
}

