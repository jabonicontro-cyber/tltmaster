"use client";

import { Toaster as Sonner } from "sonner";
import { useResolvedTheme } from "./theme-sync";

/**
 * Top centre, just below the app header: page actions sit at the top right and the form action bars at the bottom,
 * so toasts there would cover the very buttons people reach for next (hovering a toast also pauses it).
 */
export function Toaster() {
  const theme = useResolvedTheme();
  return <Sonner theme={theme} position="top-center" offset={{ top: 64 }} mobileOffset={{ top: 64 }} richColors closeButton toastOptions={{ duration: 5000 }} />;
}

export { toast } from "sonner";
