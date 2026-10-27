"use client";

import { PhoneInput } from "@/components/ui/phone-input";
import { Avatar } from "@/components/ui/avatar";
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
import { TIMEZONE_OPTIONS } from "@/lib/schemas/settings";
import type { CompanySettings } from "@/server/data/types";
import { brandingProblems, brandingStyle } from "@/lib/branding";
import { inviteUser, removeSampleData, saveBranding, saveCompanySettings, saveSequence, setRolePermission, updateUserAccess } from "@/app/(app)/settings/actions";

const ctl = (id: string, err?: string) => ({ id, name: id, ...describedBy(id, err) });

/**
 * The company's own logo and colors in the app (N15). Only this company sees
 * them; colors too light for white text are refused so the app stays readable.
 */
export function BrandingForm({ settings, canEdit, companyId }: { settings: CompanySettings; canEdit: boolean; companyId: string }) {
  const router = useRouter();
  const [color, setColor] = useState(settings.brand_color);
  const [sidebarColor, setSidebarColor] = useState(settings.brand_sidebar_color);
  const [preview, setPreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const { pending, onSubmit, fieldError: fe, formError } = useFormAction(saveBranding, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      setPreview(null);
      setRemoveLogo(false);
      router.refresh();
    },
  });
  const live = brandingProblems({ color, sidebarColor });
  const logo = removeLogo ? "" : preview ?? (settings.has_logo ? `/brand/logo?c=${companyId}&v=${encodeURIComponent(settings.updated_at)}` : "");
  return (
    <>
      <CardHeader title="Branding" description="Your logo and colors in the app, for everyone in your company. Other companies never see them. Quotes and the public website are not changed." />
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <FormError message={formError} />
          <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <Field label="Logo" htmlFor="brand_logo" error={fe("brand_logo")} className="sm:col-span-6" hint="PNG, JPEG or WebP, at most 250 KB. A wide logo on a light or transparent background works best.">
              <input
                {...ctl("brand_logo", fe("brand_logo"))}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="block w-full text-sm file:mr-3 file:rounded-xl file:border file:border-line file:bg-card file:px-3 file:py-1.5 file:font-semibold"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  setRemoveLogo(false);
                  setPreview(f ? URL.createObjectURL(f) : null);
                }}
              />
            </Field>
            {settings.has_logo ? (
              <div className="sm:col-span-6">
                <Checkbox id="remove_logo" name="remove_logo" label="Remove the logo (show the Taviron mark instead)" checked={removeLogo} onChange={(e) => setRemoveLogo(e.currentTarget.checked)} />
              </div>
            ) : null}
            <Field label="Accent color" htmlFor="brand_color" error={fe("brand_color") ?? live.brand_color} className="sm:col-span-3" hint="Buttons, links and highlights. Leave empty for the default blue.">
              <div className="flex gap-2">
                <input type="color" aria-label="Pick the accent color" value={color || "#0f6fd6"} onChange={(e) => setColor(e.target.value)} className="h-11 w-12 rounded-xl border border-line" />
                <Input {...ctl("brand_color", fe("brand_color") ?? live.brand_color)} value={color} onChange={(e) => setColor(e.target.value.trim())} placeholder="#0f6fd6" maxLength={7} />
              </div>
            </Field>
            <Field label="Document color" htmlFor="brand_sidebar_color" error={fe("brand_sidebar_color") ?? live.brand_sidebar_color} className="sm:col-span-3" hint="Headings on printed quotes. The menu follows light or dark mode and marks the current page with the accent color. Leave empty for the default navy.">
              <div className="flex gap-2">
                <input type="color" aria-label="Pick the document color" value={sidebarColor || "#0c1a2b"} onChange={(e) => setSidebarColor(e.target.value)} className="h-11 w-12 rounded-xl border border-line" />
                <Input {...ctl("brand_sidebar_color", fe("brand_sidebar_color") ?? live.brand_sidebar_color)} value={sidebarColor} onChange={(e) => setSidebarColor(e.target.value.trim())} placeholder="#0c1a2b" maxLength={7} />
              </div>
            </Field>
          </fieldset>
          <div aria-label="Branding preview" className="app-root overflow-hidden rounded-2xl border border-line" style={brandingStyle({ logo: "", color: /^#[0-9a-f]{6}$/i.test(color) ? color : "", sidebarColor: /^#[0-9a-f]{6}$/i.test(sidebarColor) ? sidebarColor : "" })}>
            <div className="flex h-14 items-center gap-3 bg-charcoal px-4">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- local preview of the chosen file
                <img src={logo} alt="Logo preview" className="h-9 max-w-44 rounded-sm bg-white object-contain p-0.5" />
              ) : (
                <span className="text-sm font-bold text-white">{settings.company_name || "Your company"}</span>
              )}
              <span className="ml-auto text-xs text-white/60">Preview</span>
            </div>
            <div className="flex items-center gap-3 bg-card p-4">
              <span className="inline-flex h-9 items-center rounded-xl bg-brand px-3 text-sm font-semibold text-white">Primary button</span>
              <span className="text-sm font-semibold text-brand-fg">A link</span>
            </div>
          </div>
          {canEdit ? (
            <Button type="submit" loading={pending} disabled={Object.keys(live).length > 0}>Save branding</Button>
          ) : (
            <p className="text-sm text-muted">Changing branding needs the settings.manage permission.</p>
          )}
        </form>
      </CardBody>
    </>
  );
}

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
              <PhoneInput {...ctl("phone", fe("phone"))} defaultValue={settings.phone} />
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
            <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Quote defaults</legend>
            <Field label="Business timezone" htmlFor="timezone" error={fe("timezone")} className="sm:col-span-3" hint="Decides what “today” means for loads, tickets and the Command Center.">
              <Select {...ctl("timezone", fe("timezone"))} defaultValue={settings.timezone}>
                {TIMEZONE_OPTIONS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Default sales tax %" htmlFor="default_tax_rate" error={fe("default_tax_rate")} className="sm:col-span-3" hint="Confirm with your accountant. Can be changed per quote.">
              <Input {...ctl("default_tax_rate", fe("default_tax_rate"))} inputMode="decimal" defaultValue={bpToInput(settings.default_tax_rate_bp) || "0"} />
            </Field>
            <Field label="Quotes valid for (days)" htmlFor="quote_validity_days" error={fe("quote_validity_days")} className="sm:col-span-3">
              <Input {...ctl("quote_validity_days", fe("quote_validity_days"))} type="number" min={1} max={365} defaultValue={settings.quote_validity_days} />
            </Field>
            <Field label="Follow up after (days)" htmlFor="quote_followup_days" error={fe("quote_followup_days")} className="sm:col-span-3" hint="Sent quotes without a response appear in the Command Center after this many days.">
              <Input {...ctl("quote_followup_days", fe("quote_followup_days"))} type="number" min={1} max={90} defaultValue={settings.quote_followup_days} />
            </Field>
            <Field label="Default quote terms" htmlFor="default_quote_terms" error={fe("default_quote_terms")} className="sm:col-span-6" hint="Starting text for new quotes. Have these reviewed before relying on them.">
              <Textarea {...ctl("default_quote_terms", fe("default_quote_terms"))} rows={5} defaultValue={settings.default_quote_terms} />
            </Field>
            <Field label="Quote footer note" htmlFor="quote_footer_note" error={fe("quote_footer_note")} className="sm:col-span-6">
              <Input {...ctl("quote_footer_note", fe("quote_footer_note"))} defaultValue={settings.quote_footer_note} />
            </Field>
          </fieldset>
          <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-2 sm:grid-cols-6">
            <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Delivery tickets</legend>
            <div className="sm:col-span-6">
              <Checkbox name="ticket_reference_required" defaultChecked={settings.ticket_reference_required} label="Require the paper or scale ticket number" />
              <p className="mt-1 text-sm text-muted">When on, a ticket entered without that number is flagged for review. Turn it off if your tickets do not carry one. Applies to tickets entered from now on.</p>
            </div>
          </fieldset>
          <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Urgent orders</legend>
            <Field
              label="Escalate when not acknowledged within (minutes)"
              htmlFor="urgent_ack_minutes"
              error={fe("urgent_ack_minutes")}
              className="sm:col-span-3"
              hint="An urgent order nobody in dispatch acknowledged in time is marked overdue in the Command Center. Leave empty for no escalation. No messages are sent."
            >
              <Input {...ctl("urgent_ack_minutes", fe("urgent_ack_minutes"))} type="number" min={5} max={1440} defaultValue={settings.urgent_ack_minutes ?? ""} />
            </Field>
          </fieldset>
          {"site_review_days_standard" in settings ? (
            <fieldset disabled={!canEdit} className="grid grid-cols-1 gap-4 sm:grid-cols-6">
              <legend className="mb-2 text-[15px] font-semibold text-ink sm:col-span-6">Job site directions</legend>
              <p className="-mt-1 text-sm text-muted sm:col-span-6">
                How often someone should re-check each job site&apos;s directions. When the time has passed, dispatch and drivers see that they are due for review. Leave empty for no interval. Changed directions always need a new check, and unverified safety or access directions are always flagged.
              </p>
              <Field label="Standard sites: review every (days)" htmlFor="site_review_days_standard" error={fe("site_review_days_standard")} className="sm:col-span-3">
                <Input {...ctl("site_review_days_standard", fe("site_review_days_standard"))} type="number" min={1} max={3650} defaultValue={settings.site_review_days_standard ?? ""} />
              </Field>
              <Field label="Safety or access critical: review every (days)" htmlFor="site_review_days_safety" error={fe("site_review_days_safety")} className="sm:col-span-3">
                <Input {...ctl("site_review_days_safety", fe("site_review_days_safety"))} type="number" min={1} max={3650} defaultValue={settings.site_review_days_safety ?? ""} />
              </Field>
            </fieldset>
          ) : null}
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
      <CardHeader title="Document numbering" description="Numbers are assigned in order and are safe when several people save at once. A number is never issued twice: changing the format never renumbers existing records, and the next number can only move forward." />
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
  /** Profile photo URL ("" = initials) and phone, as the person set them. */
  photo: string;
  phone: string;
}

export function UsersPanel({ users, currentUserId, inviteAvailable, isOwner = false }: { users: UserRow[]; currentUserId: string; inviteAvailable: boolean; isOwner?: boolean }) {
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [inviting, setInviting] = useState(false);
  const router = useRouter();
  return (
    <>
      <CardHeader
        title="Sign-ins & roles"
        description="Everyone who can sign in to this company, and their role. Each sign-in also has a record in the Directory. Accounts without a role see no data until you assign one."
        actions={<Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>Invite user</Button>}
      />
      {!inviteAvailable && (
        <div className="px-5 pt-4 sm:px-6">
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
                  <div className="flex items-center gap-3">
                    <Avatar name={u.full_name || u.email} src={u.photo} size={36} />
                    <div className="min-w-0">
                      <div className="font-semibold">{u.full_name || "—"} {u.id === currentUserId && <span className="text-sm font-normal text-muted">(you)</span>}</div>
                      <div className="text-sm break-all text-muted">{u.email}{u.phone ? ` · ${u.phone}` : ""}</div>
                    </div>
                  </div>
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
      {inviting && <InviteDialog isOwner={isOwner} onClose={() => setInviting(false)} onSaved={() => { setInviting(false); router.refresh(); }} />}
    </>
  );
}

/** "Change role or access" on a person's page: the same editor as in Sign-ins & roles. */
export function AccessEditButton({ user }: { user: UserRow }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button size="sm" variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setOpen(true)}>Change role or access</Button>
      {open && <UserDialog user={user} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); router.refresh(); }} />}
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

function InviteDialog({ onClose, onSaved, isOwner }: { onClose: () => void; onSaved: () => void; isOwner: boolean }) {
  const { pending, onSubmit, fieldError: fe, formError } = useFormAction(inviteUser, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Invited");
      onSaved();
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()} title="Invite user" description="New people receive an email link to choose a password. Someone who already has an account (for example in another company) is added directly and can switch companies from the account menu.">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <Field label="Email" htmlFor="email" required error={fe("email")}><Input {...ctl("email", fe("email"))} type="email" /></Field>
        <Field label="Name" htmlFor="full_name" required error={fe("full_name")}><Input {...ctl("full_name", fe("full_name"))} /></Field>
        <Field label="Role" htmlFor="role" required error={fe("role")}>
          <Select {...ctl("role", fe("role"))} defaultValue="office">
            {ROLES.filter((r) => isOwner || r !== "owner").map((r) => (
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
      <CardHeader title="Sample data" description="Fictional records for training, shown with a Sample badge. Remove them before go-live." />
      <CardBody className="space-y-4">
        <ul className="grid grid-cols-2 gap-2 text-[15px] sm:grid-cols-5">
          {Object.entries(counts).map(([k, v]) => (
            <li key={k} className="rounded-xl border border-line px-3 py-2">
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
