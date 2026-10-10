"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Select, Textarea, describedBy } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import { Table, TableWrap, Td, Th, Tr } from "@/components/ui/table";
import { useFormAction } from "@/components/ui/use-form-action";
import { bpToInput } from "@/lib/money";
import { ROLE_LABELS, ROLES, type AppRole } from "@/lib/permissions";
import { TIMEZONES } from "@/lib/schemas/settings";
import type { CompanySettings } from "@/server/data/types";
import { inviteUser, removeSampleData, saveCompanySettings, saveSequence, setRolePermission, updateUserAccess } from "@/app/(app)/settings/actions";

const ctl = (id: string, err?: string) => ({ id, name: id, ...describedBy(id, err) });

export function CompanySettingsForm({ settings, canEdit }: { settings: CompanySettings; canEdit: boolean }) {
  const router = useRouter();
  const { pending, onSubmit, fieldError: fe, formError } = useFormAction(saveCompanySettings, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      router.refresh();
    },
  });
  return (
    <>
      <CardHeader title="Company" description="Shown on quotes and other documents. Already-sent quotes keep the details they were sent with." />
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-6" noValidate>
          <FormError message={formError} />
          <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <Field label="Company name" htmlFor="company_name" required error={fe("company_name")} className="sm:col-span-3">
              <Input {...ctl("company_name", fe("company_name"))} defaultValue={settings.company_name} />
            </Field>
            <Field label="Phone" htmlFor="phone" error={fe("phone")} className="sm:col-span-3">
              <Input {...ctl("phone", fe("phone"))} defaultValue={settings.phone} />
            </Field>
            <Field label="Street address" htmlFor="address_line1" error={fe("address_line1")} className="sm:col-span-4">
              <Input {...ctl("address_line1", fe("address_line1"))} defaultValue={settings.address_line1} />
            </Field>
            <Field label="Line 2" htmlFor="address_line2" error={fe("address_line2")} className="sm:col-span-2">
              <Input {...ctl("address_line2", fe("address_line2"))} defaultValue={settings.address_line2} />
            </Field>
            <Field label="City" htmlFor="city" error={fe("city")} className="sm:col-span-3">
              <Input {...ctl("city", fe("city"))} defaultValue={settings.city} />
            </Field>
            <Field label="State" htmlFor="state" error={fe("state")} className="sm:col-span-1">
              <Input {...ctl("state", fe("state"))} defaultValue={settings.state} maxLength={2} className="uppercase" />
            </Field>
            <Field label="ZIP" htmlFor="postal_code" error={fe("postal_code")} className="sm:col-span-2">
              <Input {...ctl("postal_code", fe("postal_code"))} defaultValue={settings.postal_code} />
            </Field>
            <Field label="Email" htmlFor="email" error={fe("email")} className="sm:col-span-3">
              <Input {...ctl("email", fe("email"))} type="email" defaultValue={settings.email} />
            </Field>
            <Field label="Website" htmlFor="website" error={fe("website")} className="sm:col-span-3">
              <Input {...ctl("website", fe("website"))} defaultValue={settings.website} />
            </Field>
          </fieldset>
          <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <legend className="mb-2 text-sm font-bold tracking-wide text-muted uppercase sm:col-span-6">Quote defaults</legend>
            <Field label="Business timezone" htmlFor="timezone" error={fe("timezone")} className="sm:col-span-3" hint="Lake and Porter counties use Central time.">
              <Select {...ctl("timezone", fe("timezone"))} defaultValue={settings.timezone}>
                {TIMEZONES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            </Field>
            <Field label="Default sales tax %" htmlFor="default_tax_rate" error={fe("default_tax_rate")} className="sm:col-span-3" hint="Confirm with your accountant. Can be changed per quote.">
              <Input {...ctl("default_tax_rate", fe("default_tax_rate"))} inputMode="decimal" defaultValue={bpToInput(settings.default_tax_rate_bp) || "0"} />
            </Field>
            <Field label="Quotes valid for (days)" htmlFor="quote_validity_days" error={fe("quote_validity_days")} className="sm:col-span-3">
              <Input {...ctl("quote_validity_days", fe("quote_validity_days"))} type="number" min={1} max={365} defaultValue={settings.quote_validity_days} />
            </Field>
            <Field label="Follow up after (days)" htmlFor="quote_followup_days" error={fe("quote_followup_days")} className="sm:col-span-3" hint="Sent quotes without a response appear on the dashboard after this many days.">
              <Input {...ctl("quote_followup_days", fe("quote_followup_days"))} type="number" min={1} max={90} defaultValue={settings.quote_followup_days} />
            </Field>
            <Field label="Default quote terms" htmlFor="default_quote_terms" error={fe("default_quote_terms")} className="sm:col-span-6" hint="Starting text for new quotes. Have these reviewed before relying on them.">
              <Textarea {...ctl("default_quote_terms", fe("default_quote_terms"))} rows={5} defaultValue={settings.default_quote_terms} />
            </Field>
            <Field label="Quote footer note" htmlFor="quote_footer_note" error={fe("quote_footer_note")} className="sm:col-span-6">
              <Input {...ctl("quote_footer_note", fe("quote_footer_note"))} defaultValue={settings.quote_footer_note} />
            </Field>
          </fieldset>
          {canEdit ? (
            <div className="flex justify-end border-t border-line pt-4">
              <Button type="submit" loading={pending}>Save settings</Button>
            </div>
          ) : (
            <p className="text-sm text-muted">Only an owner can change company settings.</p>
          )}
        </form>
      </CardBody>
    </>
  );
}

export interface SequenceRow {
  key: string;
  label: string;
  prefix: string;
  include_year: boolean;
  pad: number;
  next_value: number;
  current_year: number | null;
}

export function SequencesPanel({ rows, year }: { rows: SequenceRow[]; year: number }) {
  const [editing, setEditing] = useState<SequenceRow | null>(null);
  const router = useRouter();
  const preview = (r: SequenceRow) => {
    const next = r.include_year && r.current_year !== year ? 1 : r.next_value;
    return `${r.prefix}${r.include_year ? `${year}-` : ""}${String(next).padStart(r.pad, "0")}`;
  };
  return (
    <>
      <CardHeader title="Document numbering" description="Numbers are assigned in order and are safe when several people save at once. Year-based numbers restart at 1 each January." />
      <TableWrap>
        <Table>
          <thead>
            <tr><Th>Document</Th><Th>Next number</Th><Th>Format</Th><Th align="right">Actions</Th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.key}>
                <Td className="font-semibold">{r.label}</Td>
                <Td className="font-mono">{preview(r)}</Td>
                <Td className="text-sm text-muted">Prefix “{r.prefix}”{r.include_year ? " + year" : ""}, {r.pad} digits</Td>
                <Td align="right">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(r)}>Edit</Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {editing && <SequenceDialog row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} />}
    </>
  );
}

function SequenceDialog({ row, onClose, onSaved }: { row: SequenceRow; onClose: () => void; onSaved: () => void }) {
  const { pending, onSubmit, fieldError: fe, formError } = useFormAction(saveSequence.bind(null, row.key), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      onSaved();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()} title={`Edit ${row.label.toLowerCase()}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <Notice tone="warning">Lowering the next number can collide with numbers already used; such saves are refused, never duplicated.</Notice>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Prefix" htmlFor="prefix" error={fe("prefix")}><Input {...ctl("prefix", fe("prefix"))} defaultValue={row.prefix} /></Field>
          <Field label="Digits" htmlFor="pad" error={fe("pad")}><Input {...ctl("pad", fe("pad"))} type="number" min={1} max={10} defaultValue={row.pad} /></Field>
          <Field label="Next number" htmlFor="next_value" error={fe("next_value")}><Input {...ctl("next_value", fe("next_value"))} type="number" min={1} defaultValue={row.next_value} /></Field>
          <div className="flex items-end pb-2"><Checkbox name="include_year" defaultChecked={row.include_year} label="Include year" /></div>
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" loading={pending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

export interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: AppRole | null;
  active: boolean;
  created_at: string;
}

export function UsersPanel({ users, currentUserId, inviteAvailable }: { users: UserRow[]; currentUserId: string; inviteAvailable: boolean }) {
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [inviting, setInviting] = useState(false);
  const router = useRouter();
  return (
    <>
      <CardHeader
        title="Users"
        description="People in your company. Accounts without a role cannot see any data until you assign one."
        actions={<Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>Invite user</Button>}
      />
      {!inviteAvailable && (
        <div className="px-4 pt-4 sm:px-5">
          <Notice tone="warning" title="Invitations are not configured">
            Set SUPABASE_SERVICE_ROLE_KEY on the server to invite users from here. Until then, create users in the Supabase dashboard and assign roles below.
          </Notice>
        </div>
      )}
      <TableWrap>
        <Table>
          <thead>
            <tr><Th>User</Th><Th>Role</Th><Th>Status</Th><Th align="right">Actions</Th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <Tr key={u.id}>
                <Td>
                  <div className="font-semibold">{u.full_name || "—"} {u.id === currentUserId && <span className="text-sm font-normal text-muted">(you)</span>}</div>
                  <div className="text-sm text-muted">{u.email}</div>
                </Td>
                <Td>{u.role ? ROLE_LABELS[u.role] : <Badge tone="amber">Waiting for a role</Badge>}</Td>
                <Td>{u.active ? <Badge tone="green">Active</Badge> : <Badge>Deactivated</Badge>}</Td>
                <Td align="right"><Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(u)}>Edit</Button></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
      {editing && <UserDialog user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} />}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onSaved={() => { setInviting(false); router.refresh(); }} />}
    </>
  );
}

function UserDialog({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: () => void }) {
  const { pending, onSubmit, fieldError: fe, formError } = useFormAction(updateUserAccess.bind(null, user.id), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      onSaved();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()} title={`Edit ${user.email}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <Field label="Name" htmlFor="full_name" required error={fe("full_name")}><Input {...ctl("full_name", fe("full_name"))} defaultValue={user.full_name} /></Field>
        <Field label="Role" htmlFor="role" error={fe("role")}>
          <Select {...ctl("role", fe("role"))} defaultValue={user.role ?? ""}>
            <option value="">No role (no access)</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </Select>
        </Field>
        <Checkbox name="active" defaultChecked={user.active} label="Account active (unchecking blocks all access)" />
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" loading={pending}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

function InviteDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { pending, onSubmit, fieldError: fe, formError } = useFormAction(inviteUser, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Invited");
      onSaved();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()} title="Invite user" description="They receive an email link to choose a password.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <Field label="Email" htmlFor="email" required error={fe("email")}><Input {...ctl("email", fe("email"))} type="email" /></Field>
        <Field label="Name" htmlFor="full_name" required error={fe("full_name")}><Input {...ctl("full_name", fe("full_name"))} /></Field>
        <Field label="Role" htmlFor="role" required error={fe("role")}>
          <Select {...ctl("role", fe("role"))} defaultValue="office">
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABELS[r]}</option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" loading={pending}>Send invitation</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function PermissionsMatrix({ permissions, granted }: { permissions: Array<{ code: string; category: string; description: string }>; granted: Record<string, string[]> }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const roles = ROLES;
  return (
    <>
      <CardHeader title="Roles and permissions" description="Checked boxes take effect immediately and are enforced by the server and the database. Owner always has every permission." />
      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>Permission</Th>
              {roles.map((r) => (
                <Th key={r} align="center">{ROLE_LABELS[r].split(" ")[0]}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permissions.map((p) => (
              <Tr key={p.code}>
                <Td>
                  <div className="font-medium">{p.description}</div>
                  <div className="font-mono text-xs text-muted">{p.category} · {p.code}</div>
                </Td>
                {roles.map((r) => {
                  const has = granted[r]?.includes(p.code) ?? false;
                  return (
                    <Td key={r} align="center">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand"
                        aria-label={`${ROLE_LABELS[r]}: ${p.description}`}
                        checked={has}
                        disabled={r === "owner" || pending}
                        onChange={() =>
                          start(async () => {
                            const res = await setRolePermission(r, p.code, !has);
                            if (res.ok) {
                              toast.success(res.message ?? "Saved");
                              router.refresh();
                            } else toast.error(res.error);
                          })
                        }
                      />
                    </Td>
                  );
                })}
              </Tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    </>
  );
}

export function SampleDataPanel({ counts }: { counts: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <>
      <CardHeader title="Sample data" description="Fictional records for training, shown with a SAMPLE badge. Remove them before go-live." />
      <CardBody className="space-y-4">
        <ul className="grid grid-cols-2 gap-2 text-[15px] sm:grid-cols-5">
          {Object.entries(counts).map(([k, v]) => (
            <li key={k} className="rounded-md border border-line px-3 py-2">
              <div className="text-xl font-black tabular">{v}</div>
              <div className="text-sm text-muted capitalize">{k.replace("_", " ")}</div>
            </li>
          ))}
        </ul>
        <Button variant="danger" disabled={total === 0} onClick={() => setOpen(true)}>Remove all sample data</Button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Remove all sample data?"
          description="Deletes sample customers, materials, charges, price lists and every quote for a sample customer. Sample items used on real quotes are deactivated instead. This cannot be undone."
          confirmLabel="Remove sample data"
          tone="danger"
          onConfirm={async () => {
            const r = await removeSampleData();
            if (!r.ok) return r.error;
            toast.success(r.message ?? "Removed");
            router.refresh();
          }}
        />
      </CardBody>
    </>
  );
}
