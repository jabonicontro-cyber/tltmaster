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
export function SendSignIn({ employeeId, email, isOwner, initialRole = "" }: { employeeId: string; email: string; isOwner: boolean; initialRole?: string }) {
  const router = useRouter();
  // No default role (owner walkthrough 2026-11-09): a silent "Driver" could give the wrong access in one click.
  const [role, setRole] = useState(initialRole);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      if (!role) return setError("Choose the role this sign-in gives.");
      setPending(true); setError(null);
      const r = await inviteEmployee(employeeId, role);
      setPending(false);
      if (!r.ok) return setError(r.error);
      toast.success(r.message ?? "Sign-in sent.");
      router.refresh();
    }}>
      <Field label="Role" htmlFor="sign-in-role" hint={`The invitation goes to ${email}.`}>
        <Select id="sign-in-role" value={role} onChange={(e) => { setRole(e.target.value); setError(null); }}>
          <option value="" disabled>Choose a role</option>
          {ROLES.filter((r) => r !== "owner" || isOwner).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
        </Select>
      </Field>
      <FormError message={error} />
      <Button type="submit" size="sm" loading={pending} icon={<Send className="size-4" />}>Send a sign-in</Button>
    </form>
  );
}
