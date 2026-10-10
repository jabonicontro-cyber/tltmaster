"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, Pencil, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import type { ServiceStatus } from "@/server/data/types";
import { setEquipmentActive, setServiceStatus } from "@/app/(app)/fleet/actions";

interface Props {
  kind: "truck" | "trailer";
  id: string;
  unitNumber: string;
  active: boolean;
  status: ServiceStatus;
  today: string;
  permissions: { edit: boolean; service: boolean };
}

export function EquipmentActions({ kind, id, unitNumber, active, status, today, permissions }: Props) {
  const router = useRouter();
  const [serviceOpen, setServiceOpen] = useState(false);
  const [activeOpen, setActiveOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [expected, setExpected] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const label = kind === "truck" ? "Truck" : "Trailer";
  const goingOut = status === "in_service";

  return (
    <div className="flex flex-wrap gap-2">
      {permissions.edit && (
        <ButtonLink href={`/fleet/${kind}s/${id}/edit`} variant="secondary" icon={<Pencil className="size-4" />}>
          Edit
        </ButtonLink>
      )}
      {permissions.service && (
        <Button
          variant={goingOut ? "danger" : "primary"}
          icon={goingOut ? <Wrench className="size-4" /> : <CheckCircle2 className="size-4" />}
          onClick={() => {
            setReason("");
            setExpected("");
            setErrors({});
            setServiceOpen(true);
          }}
        >
          {goingOut ? "Take out of service" : "Return to service"}
        </Button>
      )}
      {permissions.edit && (
        <Button variant="secondary" onClick={() => setActiveOpen(true)}>
          {active ? "Deactivate" : "Reactivate"}
        </Button>
      )}

      <ConfirmDialog
        open={serviceOpen}
        onOpenChange={setServiceOpen}
        title={goingOut ? `Take ${label.toLowerCase()} ${unitNumber} out of service` : `Return ${label.toLowerCase()} ${unitNumber} to service`}
        description={
          goingOut
            ? "It will not be eligible for assignments until it is returned to service. The change is recorded in its history."
            : "It becomes available for assignments again (if it is active)."
        }
        confirmLabel={goingOut ? "Take out of service" : "Return to service"}
        tone={goingOut ? "danger" : "primary"}
        onConfirm={async () => {
          setErrors({});
          const r = await setServiceStatus({ kind, id, status: goingOut ? "out_of_service" : "in_service", reason, expected_return_date: expected });
          if (!r.ok) {
            setErrors(r.fieldErrors ?? {});
            return r.error;
          }
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      >
        {goingOut ? (
          <div className="space-y-3">
            <Field label="Reason" htmlFor="oos-reason" required error={errors.reason} hint="e.g. Brake repair, failed inspection, flat tire">
              <Textarea id="oos-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <Field label="Expected back (optional)" htmlFor="oos-expected" error={errors.expected_return_date}>
              <Input id="oos-expected" type="date" min={today} value={expected} onChange={(e) => setExpected(e.target.value)} className="max-w-48" />
            </Field>
          </div>
        ) : (
          <Field label="Note (optional)" htmlFor="oos-note" hint="e.g. Brakes replaced, passed inspection">
            <Input id="oos-note" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={activeOpen}
        onOpenChange={setActiveOpen}
        title={active ? `Deactivate ${label.toLowerCase()} ${unitNumber}?` : `Reactivate ${label.toLowerCase()} ${unitNumber}?`}
        description={
          active
            ? "Use this when the equipment is sold or retired. It is hidden from lists and never eligible for assignments. Its history is kept."
            : "It appears in lists again. Check its service status before assigning it."
        }
        confirmLabel={active ? "Deactivate" : "Reactivate"}
        tone={active ? "danger" : "primary"}
        onConfirm={async () => {
          const r = await setEquipmentActive(kind, id, !active);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      />
    </div>
  );
}
