import { Download, FileSpreadsheet, Images } from "lucide-react";
import { CardBody, CardHeader } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { Notice } from "@/components/ui/states";
import { EXPORT_SHEETS, FILES_PER_PART, filesParts } from "@/lib/data-export";
import { exportSummary } from "@/server/data-export";
import { mfaState } from "@/server/mfa";
import { createClient } from "@/server/supabase/server";

/** The settings menu's icon for this section. */
export const DataExportIcon = Download;

const n = (v: number) => v.toLocaleString("en-US");

/**
 * Settings → Download your data (owner 2026-11-17; master plan §12 EX1). Shown to the company's owner only (the tab is
 * hidden for everyone else); the download route and the database check owner, two-step and company again.
 */
export async function DataExportPanel({ demo }: { demo: boolean }) {
  const mfa = await mfaState();
  const verified = mfa.aal === "aal2";
  const summary = verified ? await exportSummary(await createClient()) : null;
  const records = summary?.ok ? Object.values(summary.data.counts).reduce((a, b) => a + Number(b), 0) : 0;
  const parts = summary?.ok ? filesParts(summary.data.files) : 0;
  return (
    <>
      <CardHeader
        title="Download all your data"
        description="A copy of your company's records to keep, or to take with you if you leave Taviron: spreadsheets of every record, plus your ticket photos and order documents. Only the owner can download it. Each download is recorded in the audit log."
      />
      <CardBody className="space-y-5">
        {demo ? <p className="text-sm text-muted">This is a demo company: the download holds its fictional sample records.</p> : null}
        {!verified ? (
          <Notice tone="warning" title="Confirm two-step verification first">
            Your data includes invoices, payments and prices, so the download needs a code from your authenticator app.{" "}
            <a href={`/mfa?next=${encodeURIComponent("/settings?tab=export")}`} className="font-semibold text-brand-fg hover:underline">
              Set up or enter your code
            </a>
            , then come back here.
          </Notice>
        ) : summary && !summary.ok ? (
          <Notice tone="warning" title={summary.reason === "missing" ? "Not available yet" : "Cannot download right now"}>
            {summary.reason === "missing" ? "Downloading your data needs a database update that has not been installed yet." : summary.message}
          </Notice>
        ) : summary?.ok ? (
          <>
            <section aria-labelledby="export-sheets" className="space-y-2">
              <h3 id="export-sheets" className="flex items-center gap-2 text-sm font-semibold text-ink">
                <FileSpreadsheet className="size-4 text-brand-fg" aria-hidden />
                Your records as spreadsheets
              </h3>
              <p className="text-sm text-muted">
                {n(records)} records in {EXPORT_SHEETS.length} spreadsheets (.csv, one per kind: customers, job sites, orders, loads, tickets, invoices, payments,
                trucks, drivers, people, work orders, fuel, time off and more), in one zip file with a README that explains the columns.
              </p>
              <a href="/settings/export?part=spreadsheets" download className={buttonClasses("primary", "md")}>
                <Download className="size-4" aria-hidden />
                Download spreadsheets (.zip)
              </a>
            </section>
            <section aria-labelledby="export-files" className="space-y-2 border-t border-line pt-5">
              <h3 id="export-files" className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Images className="size-4 text-brand-fg" aria-hidden />
                Ticket photos and order documents
              </h3>
              {parts === 0 ? (
                <p className="text-sm text-muted">No photos or documents are saved yet.</p>
              ) : (
                <>
                  <p className="text-sm text-muted">
                    {n(summary.data.files)} {summary.data.files === 1 ? "file" : "files"}
                    {parts > 1 ? `, in ${parts} downloads of up to ${FILES_PER_PART} files each so none takes too long. Download each one.` : ", in one download."} Each zip lists its files in files.csv.
                  </p>
                  <ul className="flex flex-wrap gap-2">
                    {Array.from({ length: parts }, (_, i) => (
                      <li key={i}>
                        <a href={`/settings/export?part=files-${i + 1}`} download className={buttonClasses("secondary", "md")}>
                          <Download className="size-4" aria-hidden />
                          {parts > 1 ? `Download files, part ${i + 1} of ${parts}` : "Download photos and documents (.zip)"}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <p className="text-xs text-muted">A large company&apos;s download can take a few minutes to finish. Keep the files somewhere safe: they hold customer, payment and employee details.</p>
          </>
        ) : null}
      </CardBody>
    </>
  );
}
