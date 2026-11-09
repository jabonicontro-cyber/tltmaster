"use client";

import { usePathname } from "next/navigation";
import { SearchX } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { DocumentTitle } from "@/components/ui/document-title";
import { EmptyState } from "@/components/ui/states";
import { isPortalSlug } from "@/lib/portal";

/**
 * A wrong link inside a customer portal (a mistyped address, or a record this customer cannot see): shown in the
 * portal's own shell with a way back to the portal home, never Taviron's website 404. It says nothing about whether
 * the record exists.
 */
export default function PortalNotFound() {
  const slug = usePathname()?.split("/")[2] ?? "";
  return (
    <>
      <DocumentTitle title="Not found" />
      <EmptyState
        as="h1"
        icon={<SearchX className="size-6" aria-hidden />}
        title="This page is not available"
        description="The link may be wrong, or the page is not shared with your account. Everything you can see is on the portal home."
        action={isPortalSlug(slug) ? <ButtonLink href={`/portal/${slug}`} variant="secondary">Back to the portal home</ButtonLink> : null}
      />
    </>
  );
}
