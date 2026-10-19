"use client";

import { useRouter } from "next/navigation";
import { buttonClasses } from "@/components/ui/button";
import { startGuide } from "./guide-player";

/** Starts a guide in this browser and opens its first page. The guide only explains; it changes nothing. */
export function GuideStart({ id, href, label = "Start Guide" }: { id: string; href: string; label?: string }) {
  const router = useRouter();
  return (
    <button type="button" className={buttonClasses("secondary", "sm", "self-start")} onClick={() => { startGuide(id); router.push(href); }}>
      {label}
    </button>
  );
}
