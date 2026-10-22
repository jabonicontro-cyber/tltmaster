import { ButtonLink } from "@/components/ui/button";
import { DocumentTitle } from "@/components/ui/document-title";
import { EmptyState } from "@/components/ui/states";

export default function NotFound() {
  return (
    <>
      <DocumentTitle title="Not found" />
      <EmptyState
        as="h1"
        title="Not found"
        description="The record does not exist, was removed, or you do not have access to it."
        action={<ButtonLink href="/command-center" variant="secondary">Go to the Command Center</ButtonLink>}
      />
    </>
  );
}
