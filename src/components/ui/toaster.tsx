"use client";

import { Toaster as Sonner } from "sonner";
import { useResolvedTheme } from "./theme-sync";

export function Toaster() {
  const theme = useResolvedTheme();
  return <Sonner theme={theme} position="top-right" richColors closeButton toastOptions={{ duration: 5000 }} />;
}

export { toast } from "sonner";
