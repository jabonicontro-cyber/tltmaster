import "server-only";
import { PRODUCT_NAME } from "@/lib/product";
import { createHash } from "node:crypto";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { QuoteDocument } from "@/lib/quotes/document";

const RED = "#ED1C24";
const CHARCOAL = "#1C1E21";
const INK = "#1F2328";
const MUTED = "#5F6670";
const LINE = "#DFE2E6";

const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 40, fontSize: 9.5, fontFamily: "Helvetica", color: INK, lineHeight: 1.3 },
  draft: { borderWidth: 1.5, borderStyle: "dashed", borderColor: "#D97706", backgroundColor: "#FFFBEB", color: "#78350F", textAlign: "center", padding: 5, marginBottom: 10, fontFamily: "Helvetica-Bold", fontSize: 9 },
  header: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 3, borderBottomColor: RED, paddingBottom: 10 },
  brandRow: { flexDirection: "row", alignItems: "center" },
  brandBar: { width: 5, height: 22, backgroundColor: RED, marginRight: 6 },
  brandName: { fontFamily: "Helvetica-Bold", fontSize: 18, color: CHARCOAL },
  small: { fontSize: 8, color: MUTED },
  quoteTitle: { fontFamily: "Helvetica-Bold", fontSize: 22, color: CHARCOAL, textAlign: "right", lineHeight: 1, marginBottom: 6 },
  metaCol: { width: 170 },
  metaRow: { flexDirection: "row", justifyContent: "flex-end", fontSize: 8.5 },
  metaLabel: { color: MUTED, width: 62, textAlign: "right", marginRight: 6 },
  metaValue: { width: 92 },
  cols: { flexDirection: "row", marginTop: 14 },
  col: { flex: 1, paddingRight: 10 },
  h: { fontFamily: "Helvetica-Bold", fontSize: 7.5, color: MUTED, letterSpacing: 0.8, marginBottom: 3 },
  bold: { fontFamily: "Helvetica-Bold" },
  infoBar: { flexDirection: "row", flexWrap: "wrap", backgroundColor: "#F4F5F7", padding: 6, marginTop: 10, fontSize: 8.5 },
  infoItem: { marginRight: 18 },
  tableHead: { flexDirection: "row", backgroundColor: CHARCOAL, color: "#FFFFFF", marginTop: 14, paddingVertical: 4, fontFamily: "Helvetica-Bold", fontSize: 7.5, letterSpacing: 0.6 },
  row: { flexDirection: "row", borderBottomWidth: 0.75, borderBottomColor: LINE, paddingVertical: 4 },
  cNo: { width: 20, paddingHorizontal: 4, color: MUTED },
  cDesc: { flex: 1, paddingHorizontal: 4 },
  cQty: { width: 54, paddingHorizontal: 4, textAlign: "right" },
  cUnit: { width: 62, paddingHorizontal: 4 },
  cRate: { width: 62, paddingHorizontal: 4, textAlign: "right" },
  cAmt: { width: 72, paddingHorizontal: 4, textAlign: "right", fontFamily: "Helvetica-Bold" },
  totalsWrap: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  totals: { width: 200 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1.5 },
  grandRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1.5, borderTopColor: CHARCOAL, marginTop: 3, paddingTop: 4, fontFamily: "Helvetica-Bold", fontSize: 12 },
  section: { marginTop: 12 },
  sigRow: { flexDirection: "row", marginTop: 26 },
  sigBox: { flex: 1, marginRight: 24 },
  sigLine: { borderBottomWidth: 0.75, borderBottomColor: INK, height: 22 },
  footer: { position: "absolute", bottom: 22, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: MUTED },
});

function QuotePdf({ doc }: { doc: QuoteDocument }) {
  return (
    <Document title={doc.title} author={doc.company.name} subject={`Quote for ${doc.billTo.name}`} creator={PRODUCT_NAME}>
      <Page size="LETTER" style={s.page}>
        {doc.isDraft && <Text style={s.draft}>DRAFT — NOT YET SENT TO THE CUSTOMER</Text>}
        <View style={s.header}>
          <View>
            <View style={s.brandRow}>
              <View style={s.brandBar} />
              <Text style={s.brandName}>{doc.company.name.toUpperCase()}</Text>
            </View>
            {doc.company.addressLines.map((l) => (
              <Text key={l} style={s.small}>{l}</Text>
            ))}
            {doc.company.contactLine ? <Text style={s.small}>{doc.company.contactLine}</Text> : null}
          </View>
          <View style={s.metaCol}>
            <Text style={s.quoteTitle}>QUOTE</Text>
            <View style={s.metaRow}><Text style={s.metaLabel}>Quote #</Text><Text style={[s.metaValue, s.bold]}>{doc.quoteNumber}</Text></View>
            <View style={s.metaRow}><Text style={s.metaLabel}>Revision</Text><Text style={s.metaValue}>{String(doc.versionNo)}</Text></View>
            <View style={s.metaRow}><Text style={s.metaLabel}>Date</Text><Text style={s.metaValue}>{doc.quoteDate}</Text></View>
            <View style={s.metaRow}><Text style={s.metaLabel}>Valid until</Text><Text style={[s.metaValue, s.bold]}>{doc.validUntil}</Text></View>
          </View>
        </View>

        <View style={s.cols}>
          <View style={s.col}>
            <Text style={s.h}>BILL TO</Text>
            <Text style={s.bold}>{doc.billTo.name}</Text>
            {doc.billTo.addressLines.map((l) => <Text key={l}>{l}</Text>)}
            <Text style={s.small}>Customer # {doc.billTo.customerNumber}</Text>
          </View>
          <View style={s.col}>
            <Text style={s.h}>JOB SITE / DELIVERY</Text>
            {doc.jobSite.label ? <Text style={s.bold}>{doc.jobSite.label}</Text> : null}
            {doc.jobSite.addressLines.length ? doc.jobSite.addressLines.map((l) => <Text key={l}>{l}</Text>) : <Text style={s.small}>To be confirmed</Text>}
          </View>
          <View style={s.col}>
            <Text style={s.h}>CONTACT</Text>
            <Text style={s.bold}>{doc.contact.name || "—"}</Text>
            {doc.contact.email ? <Text>{doc.contact.email}</Text> : null}
            {doc.contact.phone ? <Text>{doc.contact.phone}</Text> : null}
          </View>
        </View>

        {doc.projectName || doc.customerPo || doc.paymentTerms ? (
          <View style={s.infoBar}>
            {doc.projectName ? <Text style={s.infoItem}>Project: <Text style={s.bold}>{doc.projectName}</Text></Text> : null}
            {doc.customerPo ? <Text style={s.infoItem}>Customer PO: <Text style={s.bold}>{doc.customerPo}</Text></Text> : null}
            {doc.paymentTerms ? <Text style={s.infoItem}>Terms: <Text style={s.bold}>{doc.paymentTerms}</Text></Text> : null}
          </View>
        ) : null}

        <View style={s.tableHead} fixed>
          <Text style={s.cNo}>#</Text>
          <Text style={s.cDesc}>DESCRIPTION</Text>
          <Text style={s.cQty}>QTY</Text>
          <Text style={s.cUnit}>UNIT</Text>
          <Text style={s.cRate}>RATE</Text>
          <Text style={s.cAmt}>AMOUNT</Text>
        </View>
        {doc.lines.map((l) => (
          <View key={l.no} style={s.row} wrap={false}>
            <Text style={s.cNo}>{String(l.no)}</Text>
            <Text style={s.cDesc}>{l.description}</Text>
            <Text style={s.cQty}>{l.quantity}</Text>
            <Text style={s.cUnit}>{l.unit}</Text>
            <Text style={s.cRate}>{l.rate}</Text>
            <Text style={s.cAmt}>{l.amount}</Text>
          </View>
        ))}

        <View style={s.totalsWrap} wrap={false}>
          <View style={{ flex: 1, paddingRight: 20 }}>
            {doc.quantitySummary.length > 0 ? (
              <Text style={s.small}>
                Material quantities: {doc.quantitySummary.map((q) => `${q.quantity} ${q.unit.toLowerCase()}`).join(" · ")}
              </Text>
            ) : null}
          </View>
          <View style={s.totals}>
            <View style={s.totalRow}><Text style={{ color: MUTED }}>Subtotal</Text><Text>{doc.totals.subtotal}</Text></View>
            {doc.totals.discount ? <View style={s.totalRow}><Text style={{ color: MUTED }}>Discounts</Text><Text>{doc.totals.discount}</Text></View> : null}
            {doc.totals.tax ? <View style={s.totalRow}><Text style={{ color: MUTED }}>{doc.totals.taxLabel}</Text><Text>{doc.totals.tax}</Text></View> : null}
            <View style={s.grandRow}><Text>Total</Text><Text>{doc.totals.total}</Text></View>
          </View>
        </View>

        {doc.jobInstructions ? (
          <View style={s.section} wrap={false}>
            <Text style={s.h}>JOB INSTRUCTIONS</Text>
            <Text>{doc.jobInstructions}</Text>
          </View>
        ) : null}
        {doc.terms ? (
          <View style={s.section}>
            <Text style={s.h}>TERMS</Text>
            <Text style={{ fontSize: 8, color: MUTED }}>{doc.terms}</Text>
          </View>
        ) : null}

        <View style={s.sigRow} wrap={false}>
          <View style={s.sigBox}><View style={s.sigLine} /><Text style={s.small}>Accepted by (signature)</Text></View>
          <View style={s.sigBox}><View style={s.sigLine} /><Text style={s.small}>Date</Text></View>
        </View>

        {doc.footerNote ? <Text style={[s.small, { textAlign: "center", marginTop: 16 }]}>{doc.footerNote}</Text> : null}

        <View style={s.footer} fixed>
          <Text>{doc.quoteNumber} · revision {doc.versionNo}{doc.isDraft ? " · DRAFT" : ""}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderQuotePdf(doc: QuoteDocument): Promise<{ buffer: Buffer; sha256: string; byteSize: number }> {
  const buffer = await renderToBuffer(<QuotePdf doc={doc} />);
  return {
    buffer,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    byteSize: buffer.byteLength,
  };
}
