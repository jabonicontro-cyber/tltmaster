import { TERMS } from "@/lib/terminology";
import { AdminFlash } from "@/components/admin/flash";
import { Field, Input } from "@/components/ui/form";
import { SubmitButton } from "@/components/ui/submit-button";
import { ConsolePageHeader, Panel, PanelBody, PanelHeader, PanelLink, groupOf } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/dates";
import { PREVIEW_LABELS, PREVIEW_ROLES } from "@/lib/platform/preview";
import { createClient } from "@/server/supabase/server";
import { PRAIRIE_LANTERN } from "@/server/demo/prairie-lantern";
import { FREIGHT_DEMO } from "@/server/demo/freight-demo";
import { PORTAL_NOT_OPENED } from "@/server/demo/samples";
import { createFreightDemo, createProspectDemo, enterDemo, refreshPresenterDemo, refreshProspectDemo, retireProspectDemo, setDemoPlan, startDemo } from "../actions";

export const metadata = { title: TERMS.demoManagement };

const PLAN_LABELS: Record<string, string> = { essential: "Essential", growth: "Growth", professional: "Professional" };
// Starting a demo seeds a few hundred records through the normal app functions.
export const maxDuration = 60;

const REFRESH_HELP = "Adds loads for recent and upcoming days that are empty and any missing sample records, and keeps sample dates and names consistent. Deletes nothing and never changes records added in the demo.";

export default async function DemoAdminPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string; loads?: string; added?: string; plan?: string; portal?: string }> }) {
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
      <ConsolePageHeader
        eyebrow={groupOf("/admin/demo")}
        title={TERMS.demoManagement}
        description="Show Taviron with separate demo companies full of fictional data. Nothing in a demo reaches a real customer, and nothing is sent."
        actions={<PanelLink href="/admin/testing-lab">Open the Testing Lab</PanelLink>}
      />
      <AdminFlash error={sp.error} saved={sp.saved} savedText={sp.saved === "retired" ? "Demo retired. You can create it again below."
        : sp.saved === "plan" ? `Demo now shows the ${PLAN_LABELS[sp.plan ?? ""] ?? "chosen"} plan: its dispatch bases and sample records follow the plan.`
        : sp.saved === "refreshed" ? `Demo refreshed: ${Number(sp.loads) || 0} loads and ${Number(sp.added) || 0} missing records added${Number(sp.loads) || Number(sp.added) ? "" : " (it was already up to date)"}.${sp.portal === "closed" ? ` ${PORTAL_NOT_OPENED}` : ""}` : "Saved."} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel aria-label={TERMS.liveDemo}>
          <PanelHeader
            title={demo ? demo.name : "No demo company yet"}
            description={demo ? `${TERMS.liveDemo} · started ${formatDateTime(demo.created_at)}` : `The ${TERMS.liveDemo} company you present from. Start one to begin.`}
          />
          <PanelBody className="space-y-5">
            {demo ? (
              <div className="space-y-4">
                <form action={enterDemo}>
                  <SubmitButton pendingLabel="Opening…">Open the demo</SubmitButton>
                </form>
                <form action={refreshPresenterDemo} className="space-y-2">
                  <SubmitButton variant="secondary" size="sm" pendingLabel="Refreshing…">Refresh demo data</SubmitButton>
                  <p className="text-xs leading-relaxed text-muted">{REFRESH_HELP}</p>
                </form>
              </div>
            ) : null}
            <form action={startDemo} className={demo ? "space-y-3 border-t border-line pt-5" : "space-y-3"}>
              <Field label="Time zone for the demo" htmlFor="tz" hint="Today's loads are created in this time zone.">
                <Input id="tz" name="timezone" defaultValue="America/Chicago" required />
              </Field>
              <SubmitButton variant={demo ? "secondary" : "primary"} pendingLabel="Creating the demo…">
                {demo ? "Reset: start a fresh demo" : "Start the demo"}
              </SubmitButton>
              {demo ? <p className="text-xs leading-relaxed text-muted">Resetting creates a new demo company and switches it off the old one. Nothing is deleted, and no real company is touched.</p> : null}
            </form>
          </PanelBody>
        </Panel>

        <Panel aria-label="Prospect demos">
          <PanelHeader title="Prospect demos" description={`A standing demo company for one prospect. Starting or resetting the ${TERMS.liveDemo} never touches them.`} />
          {!prospectsInstalled ? (
            <PanelBody><p className="text-sm text-muted">Not available yet: prospect demos need a database update.</p></PanelBody>
          ) : (
            <>
              {prospectRows.length > 0 ? (
                <ul className="border-t border-line text-sm">
                  {prospectRows.map((p) => (
                    <li key={p.id} className="space-y-3 border-b border-line/70 px-5 py-4 sm:px-6">
                      <div>
                        <p className="font-semibold text-ink">{p.name}</p>
                        <p className="text-xs text-muted">{p.slug} · created {formatDateTime(p.created_at)}</p>
                      </div>
                      {(p.name === PRAIRIE_LANTERN.name || p.name === FREIGHT_DEMO.name) && (
                        <form action={refreshProspectDemo} className="space-y-1.5">
                          <input type="hidden" name="id" value={p.id} />
                          <SubmitButton variant="secondary" size="sm" pendingLabel="Refreshing…">Refresh demo data</SubmitButton>
                          <p className="text-xs leading-relaxed text-muted">{REFRESH_HELP}</p>
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
              ) : (
                <PanelBody><p className="text-sm text-muted">None yet.</p></PanelBody>
              )}
              <PanelBody className="space-y-3 pt-4">
                {!prospectRows.some((p) => p.name === PRAIRIE_LANTERN.name) && (
                  <form action={createProspectDemo}>
                    <SubmitButton variant="secondary" pendingLabel="Creating…">Create the {PRAIRIE_LANTERN.name} demo</SubmitButton>
                  </form>
                )}
                {!prospectRows.some((p) => p.name === FREIGHT_DEMO.name) && (
                  <form action={createFreightDemo} className="space-y-1.5">
                    <SubmitButton variant="secondary" pendingLabel="Creating…">Create the {FREIGHT_DEMO.name} demo</SubmitButton>
                    <p className="text-xs text-muted">A general-freight carrier (dry vans and flatbeds, shippers and receivers, bills of lading) beside the aggregate demos.</p>
                  </form>
                )}
                <p className="text-xs leading-relaxed text-muted">
                  You become its owner to fill it with fictional data; switch to it from your company menu. No login is created here: the prospect
                  gets owner access only after they set their own password through a one-time setup link, which a Taviron Admin arranges.
                </p>
              </PanelBody>
            </>
          )}
        </Panel>

        <Panel className="lg:col-span-2">
          <PanelHeader title="Plan shown" description="Show a demo as Essential (1 dispatch base), Growth (2) or Professional (3). Its fictional trucks, drivers and orders are spread across the bases the first time; switching back to Essential returns them to the main base. Recorded in the audit log; real companies cannot be switched here." />
          {planRows === null ? (
            <PanelBody><p className="text-sm text-muted">Not available yet: showing a plan needs a database update.</p></PanelBody>
          ) : planRows.length === 0 ? (
            <PanelBody><p className="text-sm text-muted">No active demo yet.</p></PanelBody>
          ) : (
            <ul className="border-t border-line" aria-label="Demo plans">
              {planRows.map((d) => (
                <li key={d.id} className="grid grid-cols-1 gap-3 border-b border-line/70 px-5 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6">
                  <span className="text-sm"><span className="font-semibold text-ink">{d.name}</span> <span className="text-muted">· {d.demo_kind === "presenter" ? TERMS.liveDemo : "Prospect demo"} · now {PLAN_LABELS[d.demo_plan ?? "essential"]}</span></span>
                  <form action={setDemoPlan} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={d.id} />
                    <label className="sr-only" htmlFor={`plan-${d.id}`}>Plan for {d.name}</label>
                    <select id={`plan-${d.id}`} name="plan" defaultValue={d.demo_plan ?? "essential"} className="h-9 rounded-control border border-line bg-card px-2 text-sm text-ink">
                      {Object.entries(PLAN_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                    <SubmitButton variant="secondary" size="sm" pendingLabel="Switching…">Show This Plan</SubmitButton>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel className="lg:col-span-2">
          <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
            <div className="px-5 py-5 sm:px-6">
              <h2 className="text-[15px] font-semibold text-ink">How a demo is kept separate</h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
                <li>It is its own company: no other company&apos;s records are visible in it, and it cannot see theirs.</li>
                <li>Every name, place, phone number and quantity in it is fictional.</li>
                <li>Nothing leaves Taviron: quote emails are shown as previews and user invitations are turned off.</li>
                <li>It is not an import target and is not listed with customer companies.</li>
              </ul>
            </div>
            <div className="px-5 py-5 sm:px-6">
              <h2 className="text-[15px] font-semibold text-ink">Role previews</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Inside a demo, Change view in your account menu shows the app as {PREVIEW_ROLES.map((r) => PREVIEW_LABELS[r]).join(", ")}. A preview only hides
                what that role would not see: it never grants anything. The server and database keep checking your real access.
              </p>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
