"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button variant="secondary" size="sm" onClick={() => window.print()} icon={<Printer className="size-4" aria-hidden />}>
      Print
    </Button>
  );
}
