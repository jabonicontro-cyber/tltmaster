"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
      Print
    </Button>
  );
}
