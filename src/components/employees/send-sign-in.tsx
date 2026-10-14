"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Select } from "@/components/ui/form";
import { ROLE_LABELS, ROLES } from "@/lib/permissions";
import { inviteEmployee } from "@/app/(app)/employees/actions";

/** Give an existing person a Taviron sign-in, sent to their work email. */
export function SendSignIn({ employeeId, email, isOwner }: { employeeId: string; email: string; isOwner: boolean }) {
  const router = useRouter();
  const [role, setRole] = useState("driver");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      setPending(true); setError(null);
      const r = await inviteEmployee(employeeId, role);
      setPending(false);
      if (!r.ok) return setError(r.error);
      toast.success(r.message ?? "Sign-in sent.");
      router.refresh();
    }}>
      <Field label="Role" htmlFor="sign-in-role" hint={`The invitation goes to ${email}.`}>
        <Select id="sign-in-role" value={role} onChange={(e) => setRole(e.target.value)}>
          {ROLES.filter((r) => r !== "owner" || isOwner).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </Select>
      </Field>
      <FormError message={error} />
      <Button type="submit" size="sm" loading={pending} icon={<Send className="size-4" />}>Send a sign-in</Button>
    </form>
  );
}
