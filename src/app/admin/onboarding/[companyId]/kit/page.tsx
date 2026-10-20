import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { KitNav, kitSection } from "@/components/onboarding/kit-nav";
import { KitWorkspace } from "@/components/onboarding/kit-workspace";
import { integrationConfig, platformKit } from "@/server/data/onboarding-kit";
import { getAccess } from "@/server/auth";
import { requirePlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";
import { staffSaveKitForm, staffSignGoLive } from "../../kit-actions";

export const metadata = { title: "Onboarding kit" };

/** Taviron's side of a company's Onboarding kit (platform administrators). */
export default async function PlatformKitPage({ params, searchParams }: { params: Promise<{ companyId: string }>; searchParams: Promise<{ section?: string }> }) {
  await requirePlatformAdmin();
  const { companyId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) notFound();
  const section = kitSection((await searchParams).section);
  const supabase = await createClient();
  const [{ data: companies }, kit, entitlement, me] = await Promise.all([
    supabase.rpc("platform_companies"),
    platformKit(companyId),
    supabase.rpc("platform_portal_entitlement", { p_company: companyId }),
    getAccess(),
  ]);
  const company = ((companies ?? []) as Array<{ id: string; name: string }>).find((c) => c.id === companyId);
  if (!company) notFound();
  const base = `/admin/onboarding/${companyId}/kit`;
  const primary = kit.ok ? String((kit.data.forms.questionnaire?.data as { primary_contact?: string } | undefined)?.primary_contact ?? "") : "";
  return (
    <>
      <PageHeader
        title={`${company.name}: onboarding kit`}
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Onboarding", href: "/admin/onboarding" }, { label: company.name, href: `/admin/onboarding/${companyId}` }, { label: "Kit" }]}
      />
      <KitNav base={base} current={section} />
      {kit.ok ? (
        <KitWorkspace
          mode="taviron" kit={kit.data} companyName={company.name} section={section}
          onboardingContact={me?.fullName || "your onboarding contact"} supportContact="" primaryContact={primary}
          canSign config={integrationConfig(Boolean((entitlement.data as { entitled?: boolean } | null)?.entitled))}
          save={staffSaveKitForm.bind(null, companyId)} sign={staffSignGoLive.bind(null, companyId)}
          templatesBase="/onboarding/templates" checklistHref={`/admin/onboarding/${companyId}`}
        />
      ) : <Notice title={kit.reason === "not_installed" ? "Not available yet" : "Could not load"}>{kit.message}</Notice>}
    </>
  );
}
