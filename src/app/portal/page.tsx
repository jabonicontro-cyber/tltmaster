import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { myPortals } from "@/server/portal";

export const metadata = { title: { absolute: "Customer Portals" } };

/** Where a customer lands after signing in on the main sign-in page: their portal, or a choice when they have several. */
export default async function PortalChooser() {
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) redirect("/login");
  const portals = await myPortals();
  if (portals.length === 1) redirect(`/portal/${portals[0].slug}`);
  return (
    <main id="main" className="app-root flex min-h-dvh items-center justify-center bg-surface px-4 py-10 text-ink">
      <div className="w-full max-w-md rounded-lg border border-line bg-card p-6">
        <h1 className="text-xl font-bold">Your Customer Portals</h1>
        {portals.length ? (
          <ul className="mt-4 divide-y divide-line">
            {portals.map((p) => (
              <li key={p.slug}>
                <Link href={`/portal/${p.slug}`} className="block py-3 font-semibold text-ink hover:underline">{p.company}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">This account has no customer portal access. Ask the company that invited you for a new invitation.</p>
        )}
      </div>
    </main>
  );
}
