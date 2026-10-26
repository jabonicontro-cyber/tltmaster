"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { analyzeLogo, type Box } from "@/lib/logo-parts";
import { CompanyIdentity } from "./company-identity";

interface Parts {
  content: string; // the logo trimmed to its content (data URL)
  mark: string | null; // the mark alone, or null for a wordmark-only logo
  markFilled: boolean;
}

// One analysis per logo version for the page's lifetime: the sidebar persists across navigations.
const cache = new Map<string, Parts | "failed">();

function crop(img: HTMLImageElement, b: Box, pad: number): string {
  const c = document.createElement("canvas");
  c.width = b.w + pad * 2;
  c.height = b.h + pad * 2;
  c.getContext("2d")!.drawImage(img, b.x, b.y, b.w, b.h, pad, pad, b.w, b.h);
  return c.toDataURL("image/png");
}

function analyze(url: string): Promise<Parts | "failed"> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0);
        const parts = analyzeLogo(ctx.getImageData(0, 0, c.width, c.height));
        if (!parts) return resolve("failed");
        resolve({ content: crop(img, parts.content, 0), mark: parts.mark ? crop(img, parts.mark, 0) : null, markFilled: parts.markFilled });
      } catch {
        resolve("failed");
      }
    };
    img.onerror = () => resolve("failed");
    img.src = url;
  });
}

function useLogoParts(url: string): Parts | "failed" | null {
  const [parts, setParts] = useState<Parts | "failed" | null>(() => (url ? (cache.get(url) ?? null) : "failed"));
  useEffect(() => {
    if (!url || cache.has(url)) return;
    let live = true;
    void analyze(url).then((p) => {
      cache.set(url, p);
      if (live) setParts(p);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return url ? (cache.get(url) ?? parts) : "failed";
}

/**
 * The company's identity at the top of the desktop sidebar. Expanded: the logo trimmed to its content on a white tile
 * that fills the sidebar's width. Collapsed: the logo's own mark, centred on the rail's icon line; the monogram when
 * the company has no logo or the logo is a wordmark only.
 */
export function SidebarLogo({ name, logoUrl, compact }: { name: string | null; logoUrl: string; compact: boolean }) {
  const parts = useLogoParts(logoUrl);
  const label = name || "Your company";
  if (!logoUrl || parts === "failed") {
    return compact || !logoUrl ? <CompanyIdentity name={name} logoUrl="" compact={compact} /> : <LogoTile src={logoUrl} label={label} />;
  }
  if (compact) {
    if (parts === null) return <span className="block size-10 rounded-xl bg-white/[0.06]" aria-hidden />;
    if (!parts.mark) return <CompanyIdentity name={name} logoUrl="" compact />;
    return (
      // eslint-disable-next-line @next/next/no-img-element -- cropped in the browser from the company's own logo
      <img src={parts.mark} alt={label} className={cn("size-10 object-contain", parts.markFilled ? "rounded-xl" : "rounded-xl bg-white p-1")} />
    );
  }
  return <LogoTile src={parts === null ? null : parts.content} label={label} />;
}

function LogoTile({ src, label }: { src: string | null; label: string }) {
  return (
    <span className="flex h-16 w-full min-w-0 items-center justify-center rounded-2xl bg-white px-4">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a small per-company image
        <img src={src} alt={label} className="ui-fade max-h-11 w-auto max-w-full min-w-0 object-contain" />
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  );
}
