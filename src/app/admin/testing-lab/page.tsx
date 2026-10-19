import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { FlashToast } from "@/components/ui/flash-toast";
import { AUDIENCE_LABELS, CHECK_LABELS, IMPLEMENTATION_LABELS, LAB_VIEWS, latestCheck, type LabAudience, type LabCheck, type LabView } from "@/lib/platform/testing-lab";
import { formatDateTime } from "@/lib/dates";
import { requirePlatformAdmin } from "@/server/platform";
import { createClient } from "@/server/supabase/server";
import { openDemoAs, openDemoPortal, previewPortalAs, recordCheck, stopPortalPreview } from "./actions";

export const metadata = { title: "Testing Lab" };

type Demo = {
  id: string; name: string; slug: string; kind: string; plan: string | null; active: boolean; member: boolean; bases: number;
  portal: { entitled: boolean; open: boolean; public_page: boolean; accounts: number };
  customers: Array<{ id: string; name: string; orders: number }>;
};
type Check = { view_key: string; company_id: string | null; status: LabCheck; note: string; checked_at: string; checked_by: string | null };

const PLAN_LABEL: Record<string, string> = { essential: "Essential", growth: "Growth", professional: "Professional" };
const AUDIENCES = Object.keys(AUDIENCE_LABELS) as LabAudience[];

/**
 * Testing Lab (B66): open each real experience in an isolated demo company — every role's workspace, the customer
 * portal as a demo customer, the public site — and record what was actually checked. Demo companies only; nothing here
 * reaches a real customer's data, and nothing is sent.
 */
export default async function TestingLab({ searchParams }: { searchParams: Promise<{ demo?: string; error?: string; saved?: string }> }) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: list } = await supabase.from("companies").select("id, name, demo_kind, demo_plan").eq("is_demo", true).eq("active", true).order("demo_kind").order("name");
  const demos = (list ?? []) as Array<{ id: string; name: string; demo_kind: string; demo_plan: string | null }>;
  const selectedId = demos.find((d) => d.id === sp.demo)?.id ?? demos[0]?.id ?? null;
  const [demoRes, checksRes] = await Promise.all([
    selectedId ? supabase.rpc("platform_testing_demo", { p_company: selectedId }) : Promise.resolve({ data: null, error: null }),
    supabase.rpc("platform_testing_checks"),
  ]);
  const labMissing = Boolean(checksRes.error);
  const demo = (demoRes.data as Demo | null) ?? null;
  const checks = ((checksRes.data as Check[] | null) ?? []);

  return (
    <>
      <PageHeader
        title="Testing Lab"
        description="Open each Taviron experience as its real audience would see it, inside an isolated demo company, and record what you checked. Previews never use a real customer's data, and nothing is emailed, charged or sent."
        crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Testing Lab" }]}
      />
      <FlashToast messages={{ saved: { text: sp.saved === "portal" ? "Demo portal turned on (public page and tracking links on)." : "Saved." } }} />
      {sp.error ? <div className="mb-4"><Notice tone="warning" title="Not done">{sp.error}</Notice></div> : null}
      {labMissing ? (
        <div className="mb-4"><Notice tone="warning" title="Needs a database update">The Testing Lab needs migrations 20261120000700 and 20261120000800 (owner step). Role views below still work.</Notice></div>
      ) : null}

      {demos.length === 0 ? (
        <EmptyState title="No demo company yet" description="Create one in Demo Management first; the Testing Lab only ever works inside demo companies." action={<Link href="/admin/demo" className={buttonClasses("primary")}>Demo Management</Link>} />
      ) : (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Test Environment" description="Every view below opens inside this demo company. Change its plan or refresh its sample data in Demo Management." />
            <CardBody className="space-y-4">
              <form className="flex flex-wrap items-end gap-3" method="get">
                <Field label="Demo company" htmlFor="demo">
                  <Select id="demo" name="demo" defaultValue={selectedId ?? ""}>
                    {demos.map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.demo_kind === "presenter" ? "presenter demo" : "prospect demo"}{d.demo_plan ? `, ${PLAN_LABEL[d.demo_plan]}` : ""})</option>
                    ))}
                  </Select>
                </Field>
                <button type="submit" className={buttonClasses("secondary")}>Choose</button>
                <Link href="/admin/demo" className="pb-2 text-sm font-semibold text-brand-fg hover:underline">Plans and refresh in Demo Management</Link>
              </form>
              {demo ? (
                <dl className="grid gap-3 text-sm sm:grid-cols-4">
                  <Fact label="Environment" value="Demo (fictional data)" />
                  <Fact label="Plan" value={demo.plan ? PLAN_LABEL[demo.plan] : "Not set"} />
                  <Fact label="Dispatch bases" value={String(demo.bases)} />
                  <Fact label="Customer portal" value={demo.portal.open ? `Open${demo.portal.public_page ? ", public page" : ""}` : demo.portal.entitled ? "Entitled, off" : "Off"} />
                </dl>
              ) : selectedId && !labMissing ? (
                <p className="text-sm text-muted">This demo&apos;s details could not be loaded.</p>
              ) : null}
              {demo && !demo.member ? <Notice tone="warning" title="You are not a member of this demo">Role views need membership: open the demo once from Demo Management, or use a demo you created.</Notice> : null}
            </CardBody>
          </Card>

          {AUDIENCES.map((aud) => (
            <Card key={aud}>
              <CardHeader title={AUDIENCE_LABELS[aud]} />
              <CardBody>
                <ul className="divide-y divide-line">
                  {LAB_VIEWS.filter((v) => v.audience === aud).map((v) => (
                    <ViewRow key={v.key} view={v} demo={demo} companyId={selectedId} check={latestCheck(checks, v.key, selectedId)} labMissing={labMissing} />
                  ))}
                </ul>
              </CardBody>
            </Card>
          ))}

          <Card>
            <CardHeader title="Safety" />
            <CardBody className="space-y-2 text-sm text-muted">
              <p>Role views only narrow your own permissions inside the demo (the server and database keep enforcing the real ones). Customer previews are allowed by the database for demo companies only, last one hour and are recorded in the platform audit.</p>
              <p>Resetting test data is Demo Management → Refresh demo data: additive, demo companies only, never touches a real company. Emails from demos are shown, never sent; no payment provider is connected.</p>
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  );
}

function ViewRow({ view, demo, companyId, check, labMissing }: { view: LabView; demo: Demo | null; companyId: string | null; check: Check | null; labMissing: boolean }) {
  const impl = view.implementation;
  return (
    <li id={`check-${view.key}`} className="grid gap-3 py-4 lg:grid-cols-[1fr_auto]">
      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-ink">{view.title}</span>
          <Badge tone={impl === "available" ? "blue" : impl === "not_implemented" ? "gray" : "amber"}>{IMPLEMENTATION_LABELS[impl]}</Badge>
          {check ? <Badge tone={check.status === "tested" ? "green" : check.status === "failing" ? "critical-soft" : "amber"}>{CHECK_LABELS[check.status]}</Badge> : <Badge tone="gray">Not tested yet</Badge>}
        </p>
        <p className="text-sm text-muted">{view.what}</p>
        {view.note ? <p className="text-sm text-muted">{view.note}</p> : null}
        {view.migration ? <p className="text-xs text-muted">Needs migration {view.migration} on the database you are using.</p> : null}
        {check ? <p className="text-xs text-muted">{CHECK_LABELS[check.status]} {formatDateTime(check.checked_at)}{check.checked_by ? ` by ${check.checked_by}` : ""}{check.note ? ` — ${check.note}` : ""}</p> : null}
      </div>
      <div className="flex flex-col items-start gap-2 lg:items-end">
        <OpenControl view={view} demo={demo} companyId={companyId} />
        {!labMissing && impl !== "not_implemented" ? (
          <details className="w-full text-sm lg:w-auto">
            <summary className="cursor-pointer text-right font-semibold text-brand-fg">Record a result</summary>
            <form action={recordCheck} className="mt-2 flex flex-wrap items-end gap-2 lg:justify-end">
              <input type="hidden" name="view" value={view.key} />
              {companyId ? <input type="hidden" name="company" value={companyId} /> : null}
              <label className="sr-only" htmlFor={`st-${view.key}`}>Result</label>
              <Select id={`st-${view.key}`} name="status" defaultValue="tested" className="h-9 w-auto text-sm">
                <option value="tested">Tested — works</option>
                <option value="failing">Failing</option>
                <option value="needs_config">Needs configuration</option>
                <option value="blocked">Blocked</option>
                <option value="clear">Clear the result</option>
              </Select>
              <label className="sr-only" htmlFor={`note-${view.key}`}>What you checked</label>
              <Input id={`note-${view.key}`} name="note" placeholder="What you checked" maxLength={1000} className="h-9 w-56 text-sm" />
              <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">Record</SubmitButton>
            </form>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function OpenControl({ view, demo, companyId }: { view: LabView; demo: Demo | null; companyId: string | null }) {
  const o = view.open;
  if (o.kind === "link") {
    return (
      <Link href={o.href} target={o.external ? "_blank" : undefined} className={buttonClasses("secondary", "sm")}>
        Open{o.external ? <ExternalLink className="size-3.5" aria-hidden /> : null}
      </Link>
    );
  }
  if (o.kind === "role" && companyId) {
    return (
      <form action={openDemoAs}>
        <input type="hidden" name="company" value={companyId} />
        <input type="hidden" name="role" value={o.role ?? ""} />
        {o.to ? <input type="hidden" name="to" value={o.to} /> : null}
        <SubmitButton size="sm" variant="secondary" pendingLabel="Opening…" disabled={demo ? !demo.member : false}>Open in Demo</SubmitButton>
      </form>
    );
  }
  if (o.kind === "portal" && companyId && demo) {
    if (!demo.portal.open) {
      return (
        <form action={openDemoPortal}>
          <input type="hidden" name="company" value={companyId} />
          <SubmitButton size="sm" variant="secondary" pendingLabel="Turning on…" disabled={!demo.member}>Turn On Demo Portal</SubmitButton>
        </form>
      );
    }
    return (
      <div className="flex flex-wrap items-end gap-2">
        <form action={previewPortalAs} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="company" value={companyId} />
          <label className="sr-only" htmlFor="preview-customer">Demo customer</label>
          <Select id="preview-customer" name="customer" className="h-9 text-sm" required defaultValue={demo.customers.find((c) => c.orders > 0)?.id ?? ""}>
            {demo.customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.orders} orders)</option>
            ))}
          </Select>
          <SubmitButton size="sm" pendingLabel="Opening…">Preview as Customer</SubmitButton>
        </form>
        <form action={stopPortalPreview}>
          <input type="hidden" name="company" value={companyId} />
          <SubmitButton size="sm" variant="ghost" pendingLabel="Ending…">End Preview</SubmitButton>
        </form>
        {demo.portal.public_page ? <Link href={`/portal/${demo.slug}`} target="_blank" className="pb-1.5 text-sm font-semibold text-brand-fg hover:underline">Public page</Link> : null}
      </div>
    );
  }
  return null;
}
