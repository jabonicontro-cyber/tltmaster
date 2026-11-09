import type { Metadata } from "next";
import { PortalUnavailable } from "@/components/portal/portal-unavailable";

export const metadata: Metadata = { title: { absolute: "Customer Portal" }, robots: { index: false, follow: false } };

/**
 * A portal address that cannot be a portal at all (for example a malformed company name in the link). Neutral: no
 * company name, no Taviron website links, the same words as a portal that is not open.
 */
export default function PortalAddressNotFound() {
  return (
    <main id="main" className="app-root flex min-h-dvh items-center justify-center bg-surface px-4 py-10 text-ink">
      <PortalUnavailable />
    </main>
  );
}
