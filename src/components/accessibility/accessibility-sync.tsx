"use client";

import { useEffect } from "react";
import { applyAccessibility, type AccessibilitySettings } from "@/lib/accessibility";

/**
 * Brings this browser in line with the person's saved settings (their account is the source of truth), so a new
 * phone picks them up on the first page and keeps them before paint from then on. Renders nothing.
 */
export function AccessibilitySync({ settings }: { settings: AccessibilitySettings | null }) {
  useEffect(() => {
    if (settings) applyAccessibility(settings);
  }, [settings]);
  return null;
}
