import "server-only";
import { createHash } from "node:crypto";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PRODUCT_NAME } from "@/lib/product";

// The invoice a customer receives (B99): the company's own logo and colour (owner 2026-10-28), what was handed off
// for billing, what has been paid and what is still owed. Built from the stored invoice only.

const INK = "#1F2328";
const MUTED = "#5F6670";
const LINE = "#DFE2E6";

export interface InvoiceDocument {
  title: string;
  filename: string;
  isDraft: boolean;
  isVoid: boolean;
  number: string;
  issueDate: string;
  dueDate: string;
  terms: string;
  sender: { name: string; addressLines: string[]; contactLine: string; logo: string; color: string };
  billTo: { name: string; customerNumber: string; addressLines: string[] };
  orderNumber: string;
  customerPo: string;
  projectName: string;
  serviceDates: string;
  lines: Array<{ no: number; description: string; quantity: string; unit: string; rate: string; amount: string }>;
  totals: { subtotal: string; discount: string | null; tax: string | null; total: string; paid: string | null; balance: string };
  footer: string;
}

const s = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 40, fontSize: 9.5, fontFamily: "Helvetica", color: INK, lineHeight: 1.3 },
  banner: { borderWidth: 1.5, borderStyle: "dashed", padding: 5, marginBottom: 10, textAlign: "center", fontFamily: "Helvetica-Bold", fontSize: 9 },
  header: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 3, paddingBottom: 10 },
  logo: { maxWidth: 160, maxHeight: 48, objectFit: "contain", marginBottom: 6 },
  brandName: { fontFamily: "Helvetica-Bold", fontSize: 16, lineHeight: 1.15, marginBottom: 3 },
  small: { fontSize: 8, color: MUTED },
  title: { fontFamily: "Helvetica-Bold", fontSize: 22, textAlign: "right", lineHeight: 1, marginBottom: 8 },
  metaRow: { flexDirection: "row", justifyContent: "flex-end", fontSize: 8.5 },
  metaLabel: { color: MUTED, width: 62, textAlign: "right", marginRight: 6 },
  metaValue: { width: 92 },
  cols: { flexDirection: "row", marginTop: 14 },
  col: { flex: 1, paddingRight: 10 },
  h: { fontFamily: "Helvetica-Bold", fontSize: 7.5, color: MUTED, letterSpacing: 0.8, marginBottom: 3 },
  bold: { fontFamily: "Helvetica-Bold" },
  tableHead: { flexDirection: "row", color: "#FFFFFF", marginTop: 14, paddingVertical: 4, fontFamily: "Helvetica-Bold", fontSize: 7.5, letterSpacing: 0.6 },
  row: { flexDirection: "row", borderBottomWidth: 0.75, borderBottomColor: LINE, paddingVertical: 4 },
  cNo: { width: 20, paddingHorizontal: 4, color: MUTED },
  cDesc: { flex: 1, paddingHorizontal: 4 },
  cQty: { width: 54, paddingHorizontal: 4, textAlign: "right" },
  cUnit: { width: 54, paddingHorizontal: 4 },
  cRate: { width: 62, paddingHorizontal: 4, textAlign: "right" },
  cAmt: { width: 72, paddingHorizontal: 4, textAlign: "right", fontFamily: "Helvetica-Bold" },
  totals: { width: 210, marginTop: 8, marginLeft: "auto" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 1.5 },
  grandRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1.5, marginTop: 3, paddingTop: 4, fontFamily: "Helvetica-Bold", fontSize: 12 },
  footer: { position: "absolute", bottom: 22, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: MUTED },
});

function InvoicePdf({ doc }: { doc: InvoiceDocument }) {
  const brand = doc.sender.color;
  return (
    <Document title={doc.title} author={doc.sender.name} subject={`Invoice for ${doc.billTo.name}`} creator={PRODUCT_NAME}>
      <Page size="LETTER" style={s.page}>
        {doc.isDraft && <Text style={[s.banner, { borderColor: "#D97706", backgroundColor: "#FFFBEB", color: "#78350F" }]}>DRAFT — NOT YET ISSUED</Text>}
        {doc.isVoid && <Text style={[s.banner, { borderColor: "#B91C1C", backgroundColor: "#FEF2F2", color: "#7F1D1D" }]}>VOID — THIS INVOICE IS CANCELED</Text>}
        <View style={[s.header, { borderBottomColor: brand }]}>
          <View>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt */}
            {doc.sender.logo ? <Image src={doc.sender.logo} style={s.logo} /> : null}
            <Text style={[s.brandName, { color: brand }]}>{doc.sender.name}</Text>
            {doc.sender.addressLines.map((l) => <Text key={l} style={s.small}>{l}</Text>)}
            {doc.sender.contactLine ? <Text style={s.small}>{doc.sender.contactLine}</Text> : null}
          </View>
          <View>
            <Text style={[s.title, { color: brand }]}>INVOICE</Text>
            <View style={s.metaRow}><Text style={s.metaLabel}>Invoice #</Text><Text style={[s.metaValue, s.bold]}>{doc.number}</Text></View>
            <View style={s.metaRow}><Text style={s.metaLabel}>Date</Text><Text style={s.metaValue}>{doc.issueDate}</Text></View>
            <View style={s.metaRow}><Text style={s.metaLabel}>Due</Text><Text style={[s.metaValue, s.bold]}>{doc.dueDate}</Text></View>
            <View style={s.metaRow}><Text style={s.metaLabel}>Terms</Text><Text style={s.metaValue}>{doc.terms}</Text></View>
          </View>
        </View>

        <View style={s.cols}>
          <View style={s.col}>
            <Text style={s.h}>BILL TO</Text>
            <Text style={s.bold}>{doc.billTo.name}</Text>
            {doc.billTo.addressLines.map((l) => <Text key={l}>{l}</Text>)}
            {doc.billTo.customerNumber ? <Text style={s.small}>Customer # {doc.billTo.customerNumber}</Text> : null}
          </View>
          <View style={s.col}>
            <Text style={s.h}>ORDER</Text>
            <Text style={s.bold}>{doc.orderNumber}</Text>
            {doc.projectName ? <Text>{doc.projectName}</Text> : null}
            {doc.customerPo ? <Text>PO {doc.customerPo}</Text> : null}
            {doc.serviceDates ? <Text style={s.small}>Service {doc.serviceDates}</Text> : null}
          </View>
        </View>

        <View style={[s.tableHead, { backgroundColor: brand }]} fixed>
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

        <View style={s.totals} wrap={false}>
          <View style={s.totalRow}><Text style={{ color: MUTED }}>Subtotal</Text><Text>{doc.totals.subtotal}</Text></View>
          {doc.totals.discount ? <View style={s.totalRow}><Text style={{ color: MUTED }}>Discounts</Text><Text>{doc.totals.discount}</Text></View> : null}
          {doc.totals.tax ? <View style={s.totalRow}><Text style={{ color: MUTED }}>Tax</Text><Text>{doc.totals.tax}</Text></View> : null}
          <View style={[s.totalRow, { fontFamily: "Helvetica-Bold" }]}><Text>Total</Text><Text>{doc.totals.total}</Text></View>
          {doc.totals.paid ? <View style={s.totalRow}><Text style={{ color: MUTED }}>Paid</Text><Text>{doc.totals.paid}</Text></View> : null}
          <View style={[s.grandRow, { borderTopColor: brand }]}><Text>Balance due</Text><Text>{doc.totals.balance}</Text></View>
        </View>

        {doc.footer ? <Text style={[s.small, { textAlign: "center", marginTop: 24 }]}>{doc.footer}</Text> : null}

        <View style={s.footer} fixed>
          <Text>{doc.sender.name} · Invoice {doc.number}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(doc: InvoiceDocument): Promise<{ buffer: Buffer; sha256: string; byteSize: number }> {
  const buffer = await renderToBuffer(<InvoicePdf doc={doc} />);
  return { buffer, sha256: createHash("sha256").update(buffer).digest("hex"), byteSize: buffer.byteLength };
}
