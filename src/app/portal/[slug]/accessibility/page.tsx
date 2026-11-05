import { AccessibilityForm } from "@/components/accessibility/accessibility-form";
import { getMyAccessibility } from "@/server/data/accessibility";
import { requirePortalCustomer } from "@/server/portal";

export const metadata = { title: "Accessibility" };

/** Accessibility mode for customers (owner 2026-11-05): the same settings as staff, saved with their own account. */
export default async function PortalAccessibilityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await requirePortalCustomer(slug, `/portal/${slug}/accessibility`);
  const settings = await getMyAccessibility();
  return (
    <section aria-label="Accessibility" className="max-w-2xl rounded-panel bg-card pt-5 shadow-card ring-1 ring-line/60">
      <div className="px-5 pb-4 sm:px-6">
        <h1 className="text-xl font-semibold text-ink">Accessibility</h1>
        <p className="mt-1 text-sm text-muted">Make this portal easier to read and use. Only you see these settings.</p>
      </div>
      <AccessibilityForm initial={settings} />
    </section>
  );
}
