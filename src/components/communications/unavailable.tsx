import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";

/** Shown while the Communications database update is not installed. Nothing pretends to work. */
export function CommunicationsUnavailable({ title = "Communications" }: { title?: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Notice tone="warning" title="Not available yet">
        Communications needs a database update that has not been installed yet. Messages, alerts and announcements will appear here once it is.
      </Notice>
    </>
  );
}
