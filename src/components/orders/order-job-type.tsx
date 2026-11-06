"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { setOrderJobType } from "@/app/(app)/dispatch/truck-day-actions";

export type JobType = "loads" | "truck_day";
export type TruckBilling = "tickets" | "hours";

export function jobTypeText(jobType: JobType, billing: TruckBilling): string {
  if (jobType === "loads") return "A set number of loads";
  return billing === "hours" ? "Trucks for the day, billed by truck-hours" : "Trucks for the day, billed by ticket quantity";
}

/** How the order runs (UX11): a set number of loads, or N trucks for the day billed by tickets or truck-hours. */
export function OrderJobType({ orderId, jobType, billing, canEdit }: { orderId: string; jobType: JobType; billing: TruckBilling; canEdit: boolean }) {
  const router = useRouter();
  const [type, setType] = useState<JobType>(jobType);
  const [bill, setBill] = useState<TruckBilling>(billing);
  const [pending, setPending] = useState(false);
  if (!canEdit) return <span>{jobTypeText(jobType, billing)}</span>;
  const changed = type !== jobType || (type === "truck_day" && bill !== billing);
  async function save() {
    setPending(true);
    const r = await setOrderJobType({ orderId, jobType: type, billing: type === "truck_day" ? bill : "tickets" });
    setPending(false);
    if (!r.ok) {
      toast.error(r.error);
      return;
    }
    toast.success(r.message ?? "Saved.");
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="order-job-type">How this order runs</label>
      <Select id="order-job-type" value={type} onChange={(e) => setType(e.target.value as JobType)} className="w-full min-w-56 sm:w-auto">
        <option value="loads">A set number of loads</option>
        <option value="truck_day">Trucks for the day</option>
      </Select>
      {type === "truck_day" && (
        <>
          <label className="sr-only" htmlFor="order-truck-billing">How this order is billed</label>
          <Select id="order-truck-billing" value={bill} onChange={(e) => setBill(e.target.value as TruckBilling)} className="w-full min-w-56 sm:w-auto">
            <option value="tickets">Bill by ticket quantity</option>
            <option value="hours">Bill by truck-hours</option>
          </Select>
        </>
      )}
      {changed && <Button size="sm" variant="secondary" onClick={save} loading={pending}>Save how it runs</Button>}
    </div>
  );
}
