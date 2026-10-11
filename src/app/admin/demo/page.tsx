import { AdminFlash } from "@/components/admin/flash";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { PREVIEW_LABELS, PREVIEW_ROLES } from "@/lib/platform/preview";
import { createClient } from "@/server/supabase/server";
import { enterDemo, startDemo } from "../actions";

export const metadata = { title: "Live demo" };
// Starting a demo seeds a few hundred records through the normal app functions.
export const maxDuration = 60;

export default async function DemoAdminPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.rpc("platform_overview");
  const demo = (data as { demo_company?: { name: string; created_at: string } | null } | null)?.demo_company ?? null;
  return (
    <>
      <PageHeader title="Live demo" description="Show Taviron with a separate demo company full of fictional data." crumbs={[{ label: "Launchpad", href: "/admin" }, { label: "Live demo" }]} />
      <AdminFlash error={sp.error} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title={demo ? demo.name : "No demo company yet"} description={demo ? `Started ${formatDateTime(demo.created_at)}` : "Start one to begin."} />
          <CardBody className="space-y-4">
            {demo ? (
              <form action={enterDemo}>
                <SubmitButton pendingLabel="Opening…">Open the demo</SubmitButton>
              </form>
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
        <div className="space-y-4">
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
