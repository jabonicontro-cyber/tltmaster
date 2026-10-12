"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Link2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, FormError, Select } from "@/components/ui/form";
import { linkEmployeeLogin } from "@/app/(app)/employees/actions";

/** Link this employee record to one of the company's logins (people without an employee record yet), or unlink it. */
export function EmployeeLoginLink({ employeeId, linked, candidates }: { employeeId: string; linked: boolean; candidates: Array<{ user_id: string; label: string }> }) {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  if (linked) {
    return (
      <>
        <Button size="sm" variant="ghost" icon={<Unlink className="size-4" />} onClick={() => setUnlinking(true)}>Unlink login</Button>
        <ConfirmDialog open={unlinking} onOpenChange={setUnlinking} title="Unlink this login?" tone="danger" confirmLabel="Unlink"
          description="The login keeps its access and role; it is just no longer this employee record (or this driver's My Day)."
          onConfirm={async () => {
            const r = await linkEmployeeLogin(employeeId, null);
            if (!r.ok) return r.error;
            toast.success(r.message ?? "Unlinked.");
            setUnlinking(false);
            router.refresh();
          }} />
      </>
    );
  }
  if (candidates.length === 0) {
    return <p className="text-muted">Every login in this company is already linked to an employee. Invite the person from Settings → Users first.</p>;
  }
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      if (!userId) return setError("Choose a login.");
      setPending(true); setError(null);
      const r = await linkEmployeeLogin(employeeId, userId);
      setPending(false);
      if (!r.ok) return setError(r.error);
      toast.success(r.message ?? "Linked.");
      router.refresh();
    }}>
      <Field label="Link an existing login" htmlFor="link-login" hint="Their profile photo, time off and (for drivers) My Day then use this record.">
        <Select id="link-login" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a login…</option>
          {candidates.map((c) => <option key={c.user_id} value={c.user_id}>{c.label}</option>)}
        </Select>
      </Field>
      <FormError message={error} />
      <Button type="submit" size="sm" variant="secondary" loading={pending} icon={<Link2 className="size-4" />}>Link login</Button>
    </form>
  );
}
