import Link from "next/link";
import { redirect } from "next/navigation";
import { AssistantPanel } from "@/components/assistant/assistant-panel";
import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EXAMPLE_QUESTIONS } from "@/lib/ai/assistant";
import { GATE_LABELS, capability, mayUse } from "@/lib/ai/capabilities";
import { can } from "@/lib/permissions";
import { capabilityGate } from "@/server/ai/gates";
import { requireAccess } from "@/server/auth";

export const metadata = { title: "Ask Taviron" };

/**
 * Ask Taviron (docs/AI.md §12). The page always opens for people who may use it; when the capability's gate is closed
 * it says why (the reasons in full for people who manage settings) and points to the pages with the same records.
 */
export default async function AssistantPage() {
  const access = await requireAccess();
  const c = capability("ops_assistant");
  if (!mayUse(c, access.permissions)) redirect(`/no-access?missing=${encodeURIComponent(c.permission)}`);
  const gate = await capabilityGate("ops_assistant", access);
  const admin = can(access, "settings.manage");

  return (
    <>
      <PageHeader title="Ask Taviron" description="Questions about your company's operations, answered from the records you may see, with links to them. It reads; it never assigns, sends, bills or changes anything." />
      {gate.canRun ? (
        <div className="max-w-3xl">
          {gate.state === "limited" && <p className="mb-4 text-sm text-muted">Limited: {gate.reasons.join(" ")}</p>}
          <AssistantPanel examples={EXAMPLE_QUESTIONS} />
        </div>
      ) : (
        <Card className="max-w-3xl">
          <CardBody className="space-y-3 text-sm text-ink">
            <p className="font-semibold">Ask Taviron is not available for this company yet ({GATE_LABELS[gate.state]}).</p>
            {admin ? (
              <>
                <ul className="list-disc space-y-1 pl-5 text-muted">
                  {gate.reasons.map((r) => <li key={r}>{r}</li>)}
                </ul>
                <p className="text-muted">The AI settings are listed in <Link href="/setup" className="font-semibold text-brand-fg hover:underline">Company setup</Link> under AI capabilities.</p>
              </>
            ) : (
              <p className="text-muted">An administrator of your company can see what is missing in Company setup.</p>
            )}
            <p className="text-muted">
              The same records are on the <Link href="/command-center" className="font-semibold text-brand-fg hover:underline">Command Center</Link>
              {can(access, "dispatch.view") && <>, <Link href="/dispatch" className="font-semibold text-brand-fg hover:underline">Dispatch</Link></>}
              {can(access, "maintenance.view") && <>, <Link href="/maintenance" className="font-semibold text-brand-fg hover:underline">Maintenance</Link></>}
              {" "}and in the <Link href="/help" className="font-semibold text-brand-fg hover:underline">Help Center</Link>.
            </p>
          </CardBody>
        </Card>
      )}
    </>
  );
}
