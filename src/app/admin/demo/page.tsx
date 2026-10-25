import { TERMS } from "@/lib/terminology";
import { AdminFlash } from "@/components/admin/flash";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { PREVIEW_LABELS, PREVIEW_ROLES } from "@/lib/platform/preview";
import { createClient } from "@/server/supabase/server";
import { PRAIRIE_LANTERN } from "@/server/demo/prairie-lantern";
import { createProspectDemo, enterDemo, refreshPresenterDemo, refreshProspectDemo, retireProspectDemo, setDemoPlan, startDemo } from "../actions";

export const metadata = { title: TERMS.demoManagement };

const PLAN_LABELS: Record<string, string> = { essential: "Essential", growth: "Growth", professional: "Professional" };
// Starting a demo seeds a few hundred records through the normal app functions.
export const maxDuration = 60;

export default async function DemoAdminPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; loads?: string; added?: string; plan?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.rpc("platform_overview");
  const demo = (data as { demo_company?: { name: string; created_at: string } | null } | null)?.demo_company ?? null;
  // Prospect demos (migration 20261106000100); the platform admin is a member of the ones they created.
  const prospects = await supabase.from("companies").select("id, name, slug, created_at").eq("demo_kind", "prospect").eq("active", true).order("created_at");
  const prospectsInstalled = !prospects.error;
  const prospectRows = (prospects.data ?? []) as Array<{ id: string; name: string; slug: string; created_at: string }>;
  // Plan shown by each active demo (20261120000300): the presenter demo and every active prospect demo.
  const planned = await supabase.from("companies").select("id, name, demo_kind, demo_plan").eq("is_demo", true).eq("active", true).in("demo_kind", ["presenter", "prospect"]).order("demo_kind").order("name");
  const planRows = planned.error ? null : ((planned.data ?? []) as Array<{ id: string; name: string; demo_kind: string; demo_plan: string | null }>);
  return (
    <>
      <PageHeader title={TERMS.demoManagement} description="Show Taviron with a separate demo company full of fictional data." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: TERMS.demoManagement }]} />
      <AdminFlash error={sp.error} saved={sp.saved} savedText={sp.saved === "retired" ? "Demo retired. You can create it again below."
        : sp.saved === "plan" ? `Demo now shows the ${PLAN_LABELS[sp.plan ?? ""] ?? "chosen"} plan: its dispatch bases and sample records follow the plan.`
        : sp.saved === "refreshed" ? `Demo refreshed: ${Number(sp.loads) || 0} loads and ${Number(sp.added) || 0} missing records added${Number(sp.loads) || Number(sp.added) ? "" : " (it was already up to date)"}.` : "Saved."} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={demo ? demo.name : "No demo company yet"} description={demo ? `Started ${formatDateTime(demo.created_at)}` : "Start one to begin."} />
          <CardBody className="space-y-4">
            {demo ? (
              <div className="space-y-3">
                <form action={enterDemo}>
                  <SubmitButton pendingLabel="Opening…">Open the demo</SubmitButton>
                </form>
                <form action={refreshPresenterDemo} className="flex flex-wrap items-center gap-3">
                  <SubmitButton variant="secondary" size="sm" pendingLabel="Refreshing…">Refresh demo data</SubmitButton>
                  <span className="text-xs text-muted">Adds loads for recent and upcoming days that are empty, and any missing sample records. Changes and deletes nothing.</span>
                </form>
              </div>
            ) : null}
            <form action={startDemo} className="space-y-3 border-t border-line pt-4">
              <Field label="Time zone for the demo" htmlFor="tz" hint="Today's loads are created in this time zone.">
                <Input id="tz" name="timezone" defaultValue="America/Chicago" required />
              </Field>
              <SubmitButton variant={demo ? "secondary" : "primary"} pendingLabel="Creating the demo…">
                {demo ? "Reset: start a fresh demo" : "Start the demo"}
              </SubmitButton>
              {demo ? <p className="text-xs text-muted">Resetting creates a new demo company and switches it off the old one. Nothing is deleted, and no real company is touched.</p> : null}
            </form>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Prospect demo tenants" description="Standing demo companies for one prospect. Starting or resetting the live demo never touches them." />
          <CardBody className="space-y-4">
            {!prospectsInstalled ? (
              <p className="text-sm text-muted">Not available yet: prospect demos need the database update 20261106000100.</p>
            ) : (
              <>
                {prospectRows.length > 0 ? (
                  <ul className="divide-y divide-line text-sm">
                    {prospectRows.map((p) => (
                      <li key={p.id} className="space-y-1 py-2">
                        <div><span className="font-medium text-ink">{p.name}</span> <span className="text-muted">· {p.slug} · created {formatDateTime(p.created_at)}</span></div>
                        {p.name === PRAIRIE_LANTERN.name && (
                          <form action={refreshProspectDemo} className="flex flex-wrap items-center gap-3">
                            <input type="hidden" name="id" value={p.id} />
                            <SubmitButton size="sm" pendingLabel="Refreshing…">Refresh demo data</SubmitButton>
                            <span className="text-xs text-muted">Adds loads for recent and upcoming days that are empty, and any missing sample records. Changes and deletes nothing.</span>
                          </form>
                        )}
                        <form action={retireProspectDemo} className="flex flex-wrap items-center gap-3">
                          <input type="hidden" name="id" value={p.id} />
                          <label className="inline-flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" name="confirm" className="accent-brand" />Retire it (its owners lose access; nothing is deleted)</label>
                          <SubmitButton variant="secondary" size="sm" pendingLabel="Retiring…">Retire</SubmitButton>
                        </form>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted">None yet.</p>}
                {!prospectRows.some((p) => p.name === PRAIRIE_LANTERN.name) && (
                  <form action={createProspectDemo}>
                    <SubmitButton variant="secondary" pendingLabel="Creating…">Create the {PRAIRIE_LANTERN.name} demo</SubmitButton>
                  </form>
                )}
                <p className="text-xs text-muted">
                  You become its owner to fill it with fictional data; switch to it from your company menu. Its prospect gets owner access only
                  after they set their own password through a one-time setup link and the operator runs
                  <code className="mx-1">scripts/platform-admin.mjs demo-owner</code>(docs/DEPLOYMENT.md §3c). No login is created here.
                </p>
              </>
            )}
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Plan Shown" description="Show a demo as Essential (1 dispatch base), Growth (2) or Professional (3). Its fictional trucks, drivers and orders are spread across the bases the first time; switching back to Essential returns them to the main base. Audited; real companies cannot be switched here." />
          <CardBody>
            {planRows === null ? (
              <p className="text-sm text-muted">Not available yet: plan demos need the database update 20261120000300.</p>
            ) : planRows.length === 0 ? (
              <p className="text-sm text-muted">No active demo yet.</p>
            ) : (
              <ul className="divide-y divide-line" aria-label="Demo plans">
                {planRows.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <span className="text-sm"><span className="font-semibold text-ink">{d.name}</span> <span className="text-muted">· {d.demo_kind === "presenter" ? "Live Demo" : "Prospect demo"} · now {PLAN_LABELS[d.demo_plan ?? "essential"]}</span></span>
                    <form action={setDemoPlan} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={d.id} />
                      <label className="sr-only" htmlFor={`plan-${d.id}`}>Plan for {d.name}</label>
                      <select id={`plan-${d.id}`} name="plan" defaultValue={d.demo_plan ?? "essential"} className="h-9 rounded-control border border-line bg-card px-2 text-sm">
                        {Object.entries(PLAN_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                      <SubmitButton variant="secondary" size="sm" pendingLabel="Switching…">Show This Plan</SubmitButton>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
        <div className="space-y-4 lg:col-span-2">
          <Notice title="How the demo is kept separate">
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>It is its own company: no other company&apos;s records are visible in it, and it cannot see theirs.</li>
              <li>Every name, place, phone number and quantity in it is fictional.</li>
              <li>Nothing leaves Taviron: quote emails are shown as previews and user invitations are turned off.</li>
              <li>It is not an import target and is not listed with customer companies.</li>
            </ul>
          </Notice>
          <Notice title="Role previews">
            Inside the demo, a bar at the top lets you view the app as {PREVIEW_ROLES.map((r) => PREVIEW_LABELS[r]).join(", ")}. A preview only hides what that role
            would not see — it never grants anything. The server and database keep checking your real access.
          </Notice>
        </div>
      </div>
    </>
  );
}
