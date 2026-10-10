"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { formatDate } from "@/lib/dates";
import { eligibilityMessage } from "@/lib/fleet/eligibility";
import { checkEligibility, type EligibilityCheck } from "@/app/(app)/fleet/actions";

interface Option {
  id: string;
  label: string;
  inactive: boolean;
}

/** Ask the database whether a truck / trailer / driver combination may be assigned on a date. */
export function EligibilityChecker({ trucks, trailers, drivers, today }: { trucks: Option[]; trailers: Option[]; drivers: Option[]; today: string }) {
  const [truckId, setTruckId] = useState("");
  const [trailerId, setTrailerId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [on, setOn] = useState(today);
  const [result, setResult] = useState<EligibilityCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const reset = () => setResult(null);

  const select = (label: string, id: string, value: string, set: (v: string) => void, options: Option[]) => (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => { set(e.target.value); reset(); }}>
        <option value="">None</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}{o.inactive ? " (inactive)" : ""}</option>
        ))}
      </Select>
    </Field>
  );

  return (
    <Card>
      <CardHeader
        title="Check a combination"
        description="Is this truck, trailer and driver eligible to be assigned on a date? This uses the same rules dispatch will use."
      />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {select("Truck", "elig-truck", truckId, setTruckId, trucks)}
          {select("Trailer", "elig-trailer", trailerId, setTrailerId, trailers)}
          {select("Driver", "elig-driver", driverId, setDriverId, drivers)}
          <Field label="Date" htmlFor="elig-on">
            <Input id="elig-on" type="date" value={on} onChange={(e) => { setOn(e.target.value); reset(); }} />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button
            loading={pending}
            disabled={!truckId && !trailerId && !driverId}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await checkEligibility({ truckId, trailerId, driverId, on });
                if (r.ok) setResult(r.data);
                else {
                  setResult(null);
                  setError(r.error);
                }
              })
            }
          >
            Check eligibility
          </Button>
        </div>
        <FormError message={error} />
        {result && (
          <div role="status" className={`rounded-md border p-4 ${result.eligible ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
            <p className={`flex items-center gap-2 font-bold ${result.eligible ? "text-green-900" : "text-red-900"}`}>
              {result.eligible ? <CheckCircle2 className="size-5" aria-hidden /> : <XCircle className="size-5" aria-hidden />}
              {result.eligible ? "Eligible" : "Not eligible"} on {formatDate(result.on)}
            </p>
            {(result.blockers.length > 0 || result.warnings.length > 0) && (
              <ul className="mt-2 space-y-1 text-sm">
                {result.blockers.map((c) => (
                  <li key={c} className="flex items-start gap-2 text-red-900">
                    <XCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {eligibilityMessage(c)}
                  </li>
                ))}
                {result.warnings.map((c) => (
                  <li key={c} className="flex items-start gap-2 text-amber-900">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {eligibilityMessage(c)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
