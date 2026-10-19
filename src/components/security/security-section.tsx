import { Card } from "@/components/ui/card";
import { SecurityCard } from "@/components/security/security-card";
import { mfaState } from "@/server/mfa";
import { createClient } from "@/server/supabase/server";

/** My profile → Security (company members and the platform team alike). */
export async function SecuritySection() {
  const supabase = await createClient();
  const [mfa, { data: factors }, { data: events }] = await Promise.all([mfaState(), supabase.auth.mfa.listFactors(), supabase.rpc("my_security_events")]);
  return (
    <Card className="mt-5">
      <SecurityCard
        enrolled={(factors?.totp ?? []).length > 0}
        aal2={mfa.aal === "aal2"}
        required={mfa.required}
        reason={mfa.reason}
        recoveryLeft={mfa.policy?.recovery_codes ?? 0}
        installed={mfa.installed}
        events={(events as Array<{ event: string; at: string }> | null) ?? []}
      />
    </Card>
  );
}
