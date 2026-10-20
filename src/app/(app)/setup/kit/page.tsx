import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { KitNav, kitSection } from "@/components/onboarding/kit-nav";
import { KitWorkspace } from "@/components/onboarding/kit-workspace";
import { requirePagePermission } from "@/server/auth";
import { companyKit } from "@/server/data/onboarding-kit";
import { saveKitForm, signGoLive } from "../kit-actions";

export const metadata = { title: "Onboarding" };

/** The company's side of the Onboarding kit (settings.manage). Signing go-live needs the owner role. */
export default async function OnboardingKitPage({ searchParams }: { searchParams: Promise<{ section?: string }> }) {
  const access = await requirePagePermission("settings.manage");
  const section = kitSection((await searchParams).section);
  const kit = await companyKit();
  return (
    <>
      <PageHeader
        title="Onboarding"
        description="Everything needed to go live with Taviron: questionnaire, data, dispatch rules, integrations, testing and the go-live acceptance."
        crumbs={[{ label: "Company setup", href: "/setup" }, { label: "Onboarding" }]}
      />
      <KitNav base="/setup/kit" current={section} />
      {kit.ok ? (
        <KitWorkspace
          mode="company" kit={kit.data} companyName={access.companyName ?? "Your company"} section={section}
          onboardingContact="your Taviron onboarding contact" supportContact="your Taviron onboarding contact"
          primaryContact={access.fullName || "there"} canSign={access.role === "owner" && !access.isDemo}
          save={saveKitForm} sign={signGoLive} templatesBase="/onboarding/templates" checklistHref="/setup#onboarding-title"
        />
      ) : <Notice title={kit.reason === "not_installed" ? "Not available yet" : "Could not load"}>{kit.message}</Notice>}
    </>
  );
}
