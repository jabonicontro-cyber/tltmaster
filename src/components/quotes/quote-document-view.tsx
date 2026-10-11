import type { QuoteDocument } from "@/lib/quotes/document";

/** Print-friendly HTML rendering of a quote. Mirrors src/server/pdf/quote-pdf.tsx. */
export function QuoteDocumentView({ doc }: { doc: QuoteDocument }) {
  return (
    <article className="force-light print-area relative mx-auto max-w-[8.5in] bg-white px-8 py-8 text-[13px] leading-snug text-ink shadow-sm ring-1 ring-line sm:px-12">
      {doc.isDraft && (
        <div className="mb-4 rounded border-2 border-dashed border-amber-400 bg-amber-50 px-3 py-2 text-center text-sm font-bold tracking-wide text-amber-900 uppercase">
          Draft — not yet sent to the customer
        </div>
      )}
      <header className="flex flex-wrap items-start justify-between gap-6 border-b-4 border-brand pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="h-8 w-1.5 bg-brand" aria-hidden />
            <span className="text-2xl font-black tracking-tight">{doc.company.name.toUpperCase()}</span>
          </div>
          <div className="mt-1 text-xs text-muted">
            {doc.company.addressLines.map((l) => (
              <div key={l}>{l}</div>
            ))}
            {doc.company.contactLine && <div>{doc.company.contactLine}</div>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-black tracking-tight text-charcoal">QUOTE</div>
          <table className="mt-1 ml-auto text-xs">
            <tbody>
              <tr><td className="pr-3 text-muted">Quote #</td><td className="font-bold tabular">{doc.quoteNumber}</td></tr>
              <tr><td className="pr-3 text-muted">Revision</td><td className="tabular">{doc.versionNo}</td></tr>
              <tr><td className="pr-3 text-muted">Date</td><td>{doc.quoteDate}</td></tr>
              <tr><td className="pr-3 text-muted">Valid until</td><td className="font-semibold">{doc.validUntil}</td></tr>
            </tbody>
          </table>
        </div>
      </header>

      <section className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-3 print:grid-cols-3">
        <div>
          <h2 className="mb-1 text-[11px] font-bold tracking-wider text-muted uppercase">Bill to</h2>
          <p className="font-semibold">{doc.billTo.name}</p>
          {doc.billTo.addressLines.map((l) => (
            <p key={l}>{l}</p>
          ))}
          <p className="text-xs text-muted">Customer # {doc.billTo.customerNumber}</p>
        </div>
        <div>
          <h2 className="mb-1 text-[11px] font-bold tracking-wider text-muted uppercase">Job site / delivery</h2>
          {doc.jobSite.label && <p className="font-semibold">{doc.jobSite.label}</p>}
          {doc.jobSite.addressLines.length ? doc.jobSite.addressLines.map((l) => <p key={l}>{l}</p>) : <p className="text-muted">To be confirmed</p>}
        </div>
        <div>
          <h2 className="mb-1 text-[11px] font-bold tracking-wider text-muted uppercase">Contact</h2>
          {doc.contact.name ? <p className="font-semibold">{doc.contact.name}</p> : <p className="text-muted">—</p>}
          {doc.contact.email && <p>{doc.contact.email}</p>}
          {doc.contact.phone && <p>{doc.contact.phone}</p>}
        </div>
      </section>

      {(doc.projectName || doc.customerPo || doc.paymentTerms) && (
        <section className="mt-4 flex flex-wrap gap-x-8 gap-y-1 rounded bg-surface px-3 py-2 text-xs">
          {doc.projectName && <span><span className="text-muted">Project:</span> <strong>{doc.projectName}</strong></span>}
          {doc.customerPo && <span><span className="text-muted">Customer PO:</span> <strong>{doc.customerPo}</strong></span>}
          {doc.paymentTerms && <span><span className="text-muted">Terms:</span> <strong>{doc.paymentTerms}</strong></span>}
        </section>
      )}

      <table className="mt-5 w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-charcoal text-left text-[11px] tracking-wider text-white uppercase">
            <th className="px-2 py-1.5 font-semibold">#</th>
            <th className="px-2 py-1.5 font-semibold">Description</th>
            <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
            <th className="px-2 py-1.5 font-semibold">Unit</th>
            <th className="px-2 py-1.5 text-right font-semibold">Rate</th>
            <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l) => (
            <tr key={l.no} className="print-break-avoid border-b border-line">
              <td className="px-2 py-1.5 align-top text-muted tabular">{l.no}</td>
              <td className="px-2 py-1.5 align-top">{l.description}</td>
              <td className="px-2 py-1.5 text-right align-top tabular">{l.quantity}</td>
              <td className="px-2 py-1.5 align-top">{l.unit}</td>
              <td className="px-2 py-1.5 text-right align-top tabular">{l.rate}</td>
              <td className={`px-2 py-1.5 text-right align-top font-semibold tabular ${l.isDiscount ? "text-green-800" : ""}`}>{l.amount}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="mt-3 flex flex-wrap items-start justify-between gap-6 print-break-avoid">
        <div className="text-xs text-muted">
          {doc.quantitySummary.length > 0 && (
            <>
              <span className="font-semibold">Material quantities: </span>
              {doc.quantitySummary.map((s) => `${s.quantity} ${s.unit.toLowerCase()}`).join(" · ")}
            </>
          )}
        </div>
        <table className="ml-auto min-w-64 text-[13px]">
          <tbody>
            <tr><td className="py-0.5 pr-6 text-muted">Subtotal</td><td className="text-right tabular">{doc.totals.subtotal}</td></tr>
            {doc.totals.discount && <tr><td className="py-0.5 pr-6 text-muted">Discounts</td><td className="text-right tabular">{doc.totals.discount}</td></tr>}
            {doc.totals.tax && <tr><td className="py-0.5 pr-6 text-muted">{doc.totals.taxLabel}</td><td className="text-right tabular">{doc.totals.tax}</td></tr>}
            <tr className="border-t-2 border-charcoal text-base font-black">
              <td className="pt-1 pr-6">Total</td>
              <td className="pt-1 text-right tabular">{doc.totals.total}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {doc.jobInstructions && (
        <section className="mt-5 print-break-avoid">
          <h2 className="mb-1 text-[11px] font-bold tracking-wider text-muted uppercase">Job instructions</h2>
          <p className="whitespace-pre-line">{doc.jobInstructions}</p>
        </section>
      )}
      {doc.terms && (
        <section className="mt-4 print-break-avoid">
          <h2 className="mb-1 text-[11px] font-bold tracking-wider text-muted uppercase">Terms</h2>
          <p className="text-xs whitespace-pre-line text-muted">{doc.terms}</p>
        </section>
      )}

      <section className="mt-8 grid grid-cols-1 gap-6 text-xs sm:grid-cols-2 print:grid-cols-2 print-break-avoid">
        <div>
          <div className="h-8 border-b border-ink" />
          <p className="mt-1 text-muted">Accepted by (signature)</p>
        </div>
        <div>
          <div className="h-8 border-b border-ink" />
          <p className="mt-1 text-muted">Date</p>
        </div>
      </section>

      {doc.footerNote && <p className="mt-6 text-center text-xs text-muted">{doc.footerNote}</p>}
    </article>
  );
}
