import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { EXCEPTION_HELP, EXCEPTION_LABELS, formatDifference, type ExceptionKind } from "@/lib/billing/rules";
import { trimNumber } from "@/lib/fleet/labels";

const qty = (v: number | string | null | undefined) => (v === null || v === undefined ? "—" : trimNumber(v));

type Exc = { kind: ExceptionKind; load_number: number | null; line_no: number | null; expected_quantity: number | string | null; actual_quantity: number | string | null; unit_code: string | null; ticket_units: string[] | null; difference: number | string | null };

export function ExceptionTable({ rows }: { rows: Exc[] }) {
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <Th>Exception</Th>
            <Th align="right">Expected</Th>
            <Th align="right">Delivered</Th>
            <Th align="right">Difference</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, i) => (
            <Tr key={i}>
              <Td>
                <div className="font-semibold">
                  {EXCEPTION_LABELS[e.kind]}
                  {e.load_number !== null ? ` — load ${e.load_number}` : e.line_no !== null ? ` — line ${e.line_no}` : ""}
                </div>
                <div className="max-w-xl text-sm text-muted">{EXCEPTION_HELP[e.kind]}</div>
              </Td>
              <Td align="right" className="tabular">{e.expected_quantity !== null ? `${qty(e.expected_quantity)} ${e.unit_code ?? ""}` : "—"}</Td>
              <Td align="right" className="tabular">
                {e.kind.endsWith("units_differ") ? `tickets in ${(e.ticket_units ?? []).join(", ")}` : e.actual_quantity !== null ? `${qty(e.actual_quantity)} ${e.unit_code ?? ""}` : "—"}
              </Td>
              <Td align="right" className="tabular font-semibold">{e.kind.endsWith("units_differ") ? "not comparable" : formatDifference(e.difference)}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}
