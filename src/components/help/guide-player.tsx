"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { guideById, type Guide } from "@/lib/help/guides";
import { routeScore } from "@/lib/help/search";

const KEY = "taviron-guide";
type Progress = { id: string; step: number };

function read(): Progress | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Progress | null;
    return v && typeof v.id === "string" && Number.isInteger(v.step) ? v : null;
  } catch {
    return null;
  }
}

function write(p: Progress | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the guide lasts for this page only
  }
  window.dispatchEvent(new Event("taviron-guide"));
}

/** Start (or restart) a guide from anywhere; the caller then navigates to the first step. */
export function startGuide(id: string) {
  write({ id, step: 0 });
}

/**
 * The guide card and highlight. Mounted once in the app shell; it reads the current guide from this browser and
 * explains one step at a time. It never clicks, fills or submits anything — the person stays in control. A step whose
 * control is not on the page (another role, a missing setup step) says so and can be skipped.
 */
export function GuidePlayer() {
  const path = usePathname();
  const [progress, setProgress] = useState<Progress | null>(null);
  // Whether the current step's control was found, keyed by step so a stale answer is never shown.
  const [lookup, setLookup] = useState<{ key: string; found: boolean } | null>(null);

  useEffect(() => {
    const sync = () => setProgress(read());
    sync();
    window.addEventListener("taviron-guide", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("taviron-guide", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const guide: Guide | undefined = progress ? guideById(progress.id) : undefined;
  const index = guide && progress ? Math.min(progress.step, guide.steps.length - 1) : 0;
  const step = guide ? guide.steps[index] : undefined;
  const here = step ? routeScore(step.route, path) >= 0 : false;

  // Highlight the step's control (its stable data-guide anchor), scrolled into view; removed when the step changes.
  useEffect(() => {
    if (!step?.anchor || !here) return;
    const key = `${progress?.id}:${index}:${path}`;
    let el: Element | null = null;
    const t = window.setTimeout(() => {
      el = document.querySelector(`[data-guide="${CSS.escape(step.anchor!)}"]`);
      setLookup({ key, found: Boolean(el) });
      if (el) {
        el.setAttribute("data-guide-active", "true");
        el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    }, 150);
    return () => {
      window.clearTimeout(t);
      el?.removeAttribute("data-guide-active");
    };
  }, [step, here, path, progress?.id, index]);
  const found = step?.anchor && here && lookup?.key === `${progress?.id}:${index}:${path}` ? lookup.found : null;

  const go = useCallback(
    (delta: number) => {
      if (!guide) return;
      const next = index + delta;
      write(next >= guide.steps.length ? null : { id: guide.id, step: Math.max(0, next) });
    },
    [guide, index],
  );

  if (!guide || !step) return null;
  const last = index + 1 === guide.steps.length;
  return (
    <aside aria-label="Guide" className="no-print fixed right-4 bottom-20 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-line bg-card p-4 shadow-xl md:bottom-6">
      <div className="flex items-start justify-between gap-3">
        <div aria-live="polite">
          <p className="text-xs font-semibold text-muted">
            {guide.title} · Step {index + 1} of {guide.steps.length}
          </p>
          <h2 className="mt-0.5 text-base font-semibold text-ink">{step.title}</h2>
        </div>
        <button type="button" onClick={() => write(null)} className="rounded-md p-1 text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-strong" aria-label={`Exit the guide: ${guide.title}`}>
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <p className="mt-2 text-sm text-ink">{step.body}</p>
      {!here ? (
        <p className="mt-2 text-sm text-muted">
          This step is on another page.{" "}
          <Link className="font-semibold text-brand-fg underline" href={step.href ?? step.route.replace(/\/\*$/, "")}>
            Go there
          </Link>
        </p>
      ) : found === false ? (
        <p className="mt-2 text-sm text-muted">This control is not on the page for your role or setup. You can skip this step.</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {index > 0 ? (
          <button type="button" onClick={() => go(-1)} className={buttonClasses("secondary", "sm")}>
            Back
          </button>
        ) : null}
        <button type="button" onClick={() => go(1)} className={buttonClasses("primary", "sm")}>
          {last ? "Finish" : "Next"}
        </button>
        <button type="button" onClick={() => write({ id: guide.id, step: 0 })} className="ml-auto rounded px-1 text-xs font-semibold text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-strong">
          Restart
        </button>
      </div>
    </aside>
  );
}
