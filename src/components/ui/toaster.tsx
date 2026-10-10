"use client";

import { Toaster as Sonner } from "sonner";

export function Toaster() {
  return <Sonner position="top-right" richColors closeButton toastOptions={{ duration: 5000 }} />;
}

export { toast } from "sonner";
