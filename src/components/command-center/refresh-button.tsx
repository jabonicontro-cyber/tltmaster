"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Re-reads every section from the database. No background polling. */
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={pending} onClick={() => start(() => router.refresh())}>
      Refresh
    </Button>
  );
}
