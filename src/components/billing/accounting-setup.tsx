"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Building2, Link2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { disconnectQuickBooks, saveBillingEntity, saveBillingRules, setQuickBooksItem } from "@/app/(app)/billing/accounting-actions";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import type { ActionResult } from "@/lib/action-result";
import type { AccountingConnection, BillingEntity } from "@/server/data/accounting";

// Billing businesses (cost centers) and their QuickBooks connections (master plan B82, B89). One card per business:
// its details, its QuickBooks company and the product or service its invoice lines use. Above them, which business
// bills each charge type.

export const CHARGE_KINDS = [
  ["material", "Materials"], ["hauling", "Hauling and delivery"], ["service", "Services"],
  ["surcharge", "Surcharges"], ["discount", "Discounts"], ["other", "Other charges"],
] as const;

function useRun(after?: () => void) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (p: () => Promise<ActionResult>) =>
    start(async () => {
      setError(null);
      const r = await p();
      if (r.ok) { toast.success(r.message ?? "Saved."); after?.(); router.refresh(); } else setError(r.error);
    });
  return { pending, error, run };
}

export function EntityDialog({ entity, onClose }: { entity: BillingEntity | null; onClose: () => void }) {
  const [v, setV] = useState(() => ({
    name: entity?.name ?? "", legal_name: entity?.legal_name ?? "", address_line1: entity?.address_line1 ?? "", address_line2: entity?.address_line2 ?? "",
    city: entity?.city ?? "", region: entity?.region ?? "", postal_code: entity?.postal_code ?? "", phone: entity?.phone ?? "", email: entity?.email ?? "",
    invoice_prefix: entity?.invoice_prefix ?? "", is_default: entity?.is_default ?? false, active: entity?.active ?? true,
  }));
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const { pending, error, run } = useRun(onClose);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={entity ? `Edit ${entity.name}` : "Add a business"}
      description="A business that sends its own invoices, with its own remit-to details and QuickBooks."
      footer={<><Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button><Button loading={pending} onClick={() => run(() => saveBillingEntity({ id: entity?.id ?? null, ...v }))}>Save business</Button></>}>
      <div className="space-y-4">
        <FormError message={error} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="be-name" required hint="As people say it, e.g. Top Line Stone & Sand"><Input id="be-name" value={v.name} onChange={set("name")} maxLength={120} /></Field>
          <Field label="Legal name" htmlFor="be-legal" hint="On invoices, if different"><Input id="be-legal" value={v.legal_name} onChange={set("legal_name")} maxLength={200} /></Field>
          <Field label="Address" htmlFor="be-a1"><Input id="be-a1" value={v.address_line1} onChange={set("address_line1")} maxLength={200} /></Field>
          <Field label="Address line 2" htmlFor="be-a2"><Input id="be-a2" value={v.address_line2} onChange={set("address_line2")} maxLength={200} /></Field>
          <Field label="City" htmlFor="be-city"><Input id="be-city" value={v.city} onChange={set("city")} maxLength={100} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="State" htmlFor="be-region"><Input id="be-region" value={v.region} onChange={set("region")} maxLength={50} /></Field>
            <Field label="ZIP" htmlFor="be-zip"><Input id="be-zip" value={v.postal_code} onChange={set("postal_code")} maxLength={20} /></Field>
          </div>
          <Field label="Phone" htmlFor="be-phone"><Input id="be-phone" value={v.phone} onChange={set("phone")} maxLength={40} /></Field>
          <Field label="Billing email" htmlFor="be-email"><Input id="be-email" type="email" value={v.email} onChange={set("email")} maxLength={200} /></Field>
          <Field label="Invoice prefix" htmlFor="be-prefix" hint="Optional, e.g. SS or TR"><Input id="be-prefix" value={v.invoice_prefix} onChange={set("invoice_prefix")} maxLength={6} className="uppercase" /></Field>
        </div>
        <div className="flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={v.is_default} onChange={set("is_default")} /> Default business (bills anything without a rule)</label>
          {entity && <label className="flex items-center gap-2"><input type="checkbox" checked={v.active} onChange={set("active")} /> Active</label>}
        </div>
      </div>
    </Dialog>
  );
}

export function SplitRules({ entities, rules, canManage }: { entities: BillingEntity[]; rules: Record<string, string>; canManage: boolean }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(CHARGE_KINDS.map(([k]) => [k, rules[k] ?? ""])));
  const { pending, error, run } = useRun();
  const fallback = entities.find((e) => e.is_default)?.name ?? "the default business";
  return (
    <Card>
      <CardHeader title="Who bills what" description={`Each charge on an order goes to one business's invoice. Anything without a choice goes to ${fallback}. Dispatch and tickets are not affected: one order, one set of loads.`} />
      <CardBody className="space-y-3">
        <FormError message={error} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CHARGE_KINDS.map(([kind, label]) => (
            <Field key={kind} label={label} htmlFor={`rule-${kind}`}>
              <Select id={`rule-${kind}`} value={v[kind]} disabled={!canManage} onChange={(e) => setV({ ...v, [kind]: e.target.value })}>
                <option value="">Default ({fallback})</option>
                {entities.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Select>
            </Field>
          ))}
        </div>
        {canManage && <Button loading={pending} onClick={() => run(() => saveBillingRules(v))}>Save billing split</Button>}
      </CardBody>
    </Card>
  );
}

export function QuickBooksPanel({ entityId, connection, items, itemsError, canManage, configured, isDemo }: {
  entityId: string | null; connection: AccountingConnection | null; items: Array<{ Id: string; Name: string }> | null; itemsError: string | null;
  canManage: boolean; configured: boolean; isDemo: boolean;
}) {
  const [item, setItem] = useState(connection?.item_id ?? "");
  const [confirm, setConfirm] = useState(false);
  const router = useRouter();
  const { pending, error, run } = useRun();
  const connectHref = `/api/accounting/qbo/connect${entityId ? `?entity=${entityId}` : ""}`;
  if (isDemo) return <p className="text-sm text-muted">Demo: QuickBooks is not connected in demo companies. <strong className="text-ink">Send to QuickBooks</strong> on handed-off orders is simulated, and nothing is sent.</p>;
  if (!connection) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted">Not connected.</p>
        {canManage && (configured
          ? <ButtonLink href={connectHref} size="sm" icon={<Link2 className="size-4" aria-hidden />}>Connect QuickBooks</ButtonLink>
          : <p className="flex flex-wrap items-center gap-2 text-sm text-muted"><Badge tone="blue">Coming soon</Badge> QuickBooks Online sync is switched on closer to launch. Businesses and the billing split work now.</p>)}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <FormError message={error} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={connection.status === "connected" ? "green" : "amber"}>{connection.status === "connected" ? "Connected" : "Connect again"}</Badge>
        <span className="font-medium text-ink">{connection.company_name || `QuickBooks company ${connection.realm_id}`}</span>
        {connection.environment === "sandbox" && <Badge tone="gray">Sandbox (test company)</Badge>}
      </div>
      {connection.status === "needs_reconnect" && canManage && <ButtonLink href={connectHref} size="sm" variant="secondary">Connect again</ButtonLink>}
      <Field label="Product or service for invoice lines" htmlFor={`item-${connection.id}`} hint={itemsError ?? "Each charge becomes a line on this item, with Taviron's own description and amount."}>
        <div className="flex flex-wrap gap-2">
          <Select id={`item-${connection.id}`} value={item} disabled={!canManage || !items} onChange={(e) => setItem(e.target.value)} className="max-w-sm">
            <option value="">Choose…</option>
            {(items ?? []).map((i) => <option key={i.Id} value={i.Id}>{i.Name}</option>)}
            {connection.item_id && !(items ?? []).some((i) => i.Id === connection.item_id) && <option value={connection.item_id}>{connection.item_name || "Current item"}</option>}
          </Select>
          {canManage && <Button size="sm" variant="secondary" disabled={!item || item === connection.item_id} loading={pending}
            onClick={() => run(() => setQuickBooksItem({ connectionId: connection.id, itemId: item, itemName: items?.find((i) => i.Id === item)?.Name ?? connection.item_name }))}>Use this item</Button>}
        </div>
      </Field>
      {canManage && <Button size="sm" variant="ghost" icon={<Unlink className="size-4" aria-hidden />} onClick={() => setConfirm(true)}>Disconnect</Button>}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Disconnect QuickBooks?" confirmLabel="Disconnect"
        description="Taviron stops sending to this QuickBooks company and forgets its customer matches. Invoices already in QuickBooks stay there."
        onConfirm={async () => {
          const r = await disconnectQuickBooks({ connectionId: connection.id });
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Disconnected.");
          router.refresh();
        }} />
    </div>
  );
}

export function AddBusinessButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={<Building2 className="size-4" aria-hidden />} onClick={() => setOpen(true)}>Add a business</Button>
      {open && <EntityDialog entity={null} onClose={() => setOpen(false)} />}
    </>
  );
}

export function EditBusinessButton({ entity }: { entity: BillingEntity }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Edit</Button>
      {open && <EntityDialog entity={entity} onClose={() => setOpen(false)} />}
    </>
  );
}
