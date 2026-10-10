import Link from "next/link";
import { notFound } from "next/navigation";
import { Download } from "lucide-react";
import { PrintButton } from "@/components/quotes/print-button";
import { QuoteDocumentView } from "@/components/quotes/quote-document-view";
import { buttonClasses } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Notice } from "@/components/ui/states";
import { requirePagePermission } from "@/server/auth";
import { loadQuoteDocument } from "@/server/quotes/document-loader";

export const metadata = { title: "Quote preview" };

export default async function QuoteVersionPage({ params }: { params: Promise<{ id: string; versionId: string }> }) {
  await requirePagePermission("quotes.view");
  const { id, versionId } = await params;
  const loaded = await loadQuoteDocument(id, versionId);
  if (!loaded) notFound();
  const { quote, version, doc } = loaded;
  const isCurrent = quote.current_version_id === version.id;

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={`${quote.quote_number} — revision ${version.version_no}`}
          crumbs={[{ label: "Quotes", href: "/quotes" }, { label: quote.quote_number, href: `/quotes/${id}` }, { label: `Revision ${version.version_no}` }]}
          actions={
            <>
              <PrintButton />
              <a href={`/quotes/${id}/versions/${versionId}/pdf?download=1`} className={buttonClasses("secondary")}>
                <Download className="size-4" aria-hidden /> Download PDF
              </a>
              <Link href={`/quotes/${id}`} className={buttonClasses("ghost")}>Back to quote</Link>
            </>
          }
        />
        <div className="mb-4 space-y-2">
          {!isCurrent && (
            <Notice tone="warning" title="Older revision">
              This is a previous revision kept for the record. The current revision may differ.
            </Notice>
          )}
          {doc.isDraft && (
            <Notice>This revision is still a draft. Customer and company details are shown as they are today and will be frozen when the quote is sent.</Notice>
          )}
        </div>
      </div>
      <QuoteDocumentView doc={doc} />
    </>
  );
}
