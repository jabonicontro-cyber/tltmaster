"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DumpTruck } from "./dump-truck";

// The 3D scene is loaded only in browsers that can show it, after the page is interactive (three.js stays out of
// the first load). Until then — and wherever WebGL is unavailable — the original static truck illustration shows.
const TruckScene = dynamic(() => import("./truck-scene").then((m) => m.TruckScene), { ssr: false });

export interface StoryChapter {
  id: string;
  eyebrow: string;
  title: ReactNode;
  body: ReactNode;
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * Scroll-driven story: chapters scroll normally on one side while the truck stays in view on the other and moves
 * through a few camera shots as the reader advances. Scrolling is never captured or slowed; the text is ordinary
 * page content (readable and navigable with the visual off). With reduced motion the truck stays in one pose; without
 * WebGL the static illustration is shown.
 */
export function TruckStory({ intro, chapters }: { intro: ReactNode; chapters: StoryChapter[] }) {
  const section = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  const [mode, setMode] = useState<"static" | "3d" | "3d-still">("static");
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(0);
  const onReady = useCallback(() => setReady(true), []);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!webglAvailable()) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Mount after the browser is idle so the 3D code never competes with the first paint.
    const go = () => setMode(still ? "3d-still" : "3d");
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 1500 });
    else setTimeout(go, 300);
  }, []);

  useEffect(() => {
    if (mode !== "3d") return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const el = section.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const total = r.height - window.innerHeight;
      const p = total > 0 ? Math.min(Math.max(-r.top / total, 0), 1) : 0;
      progress.current = p;
      setActive(Math.min(chapters.length, Math.floor(p * (chapters.length + 1))));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [mode, chapters.length]);

  return (
    <div ref={section} className="truck-story relative" data-mode={mode} data-ready={ready ? "yes" : "no"}>
      <div className="grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-10">
        {/* On wide screens the scene spans the whole section behind the text (the truck is framed to the right), so the
            rig is never cropped by a column; the text keeps its own column on top. */}
        {/* The visual stays in view: beside the text on wide screens, pinned above it on phones. */}
        <div className="truck-visual pointer-events-none sticky top-14 z-10 order-first h-[38vh] min-h-[240px] bg-navy/90 backdrop-blur-sm lg:z-0 lg:col-span-2 lg:col-start-1 lg:row-start-1 lg:mx-[calc(50%-50vw)] lg:self-start lg:bg-transparent lg:backdrop-blur-none lg:top-16 lg:h-[calc(100vh-4rem)]" aria-hidden>
          <div className="truck-stage absolute inset-0">
            {/* Keeps the text legible where it overlaps the scene on wide screens. */}
            <div className="absolute inset-y-0 left-0 z-10 hidden w-[48%] bg-gradient-to-r from-navy via-navy/80 to-transparent lg:block" />
            <DumpTruck className={`absolute inset-x-[4%] bottom-[12%] w-[92%] lg:left-auto lg:right-0 lg:w-[52%] transition-opacity duration-700 ${ready ? "opacity-0" : "opacity-100"}`} />
            {mode !== "static" && (
              <TruckScene progress={progress} onReady={onReady} frameRight={wide ? 0.24 : 0} className={`absolute inset-0 transition-opacity duration-700 ${ready ? "opacity-100" : "opacity-0"}`} />
            )}
          </div>
        </div>
        <div className="relative z-10 lg:col-start-1 lg:row-start-1">
          <div className="flex min-h-[70vh] flex-col justify-center py-10 lg:min-h-[calc(100vh-4rem)]">{intro}</div>
          {chapters.map((c, i) => (
            <section key={c.id} id={c.id} aria-labelledby={`${c.id}-title`} className="flex min-h-[60vh] flex-col justify-center py-12 lg:min-h-[85vh]">
              <p className={`text-sm font-semibold tracking-wide text-electric uppercase transition-opacity duration-500 ${mode === "3d" && active !== i + 1 ? "lg:opacity-60" : ""}`}>{c.eyebrow}</p>
              <h2 id={`${c.id}-title`} className="mt-3 max-w-xl text-3xl font-bold tracking-tight text-balance text-cloud sm:text-4xl">{c.title}</h2>
              <div className="mt-4 max-w-xl space-y-3 text-[17px] leading-relaxed text-silver">{c.body}</div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
