"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Pencil, Plus, Star, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, FormError, Input, Textarea, describedBy } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/states";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ContactRow, SiteRow } from "@/server/data/types";
import {
  saveContact,
  saveSite,
  setContactActive,
  setCustomerActive,
  setSiteActive,
} from "@/app/(app)/customers/actions";

export function ContactsPanel({ customerId, contacts, canEdit }: { customerId: string; contacts: ContactRow[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<ContactRow | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const visible = contacts.filter((c) => showArchived || c.active);

  return (
    <Card>
      <CardHeader
        title="Contacts"
        actions={
          canEdit && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              Add contact
            </Button>
          )
        }
      />
      {visible.length === 0 ? (
        <EmptyState icon={<UserRound className="size-6" />} title="No contacts" description="Add the people you deal with for quotes and billing." className="py-8" />
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {c.name}
                  {c.is_primary && (
                    <Badge tone="brand">
                      <Star className="size-3" aria-hidden /> Primary
                    </Badge>
                  )}
                  {c.is_billing && <Badge tone="blue">Billing</Badge>}
                  {!c.active && <Badge>Archived</Badge>}
                </p>
                {c.title && <p className="text-sm text-muted">{c.title}</p>}
                <p className="mt-0.5 text-sm">
                  {[c.email, c.phone].filter(Boolean).join(" · ") || <span className="text-muted">No email or phone</span>}
                </p>
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(c)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await setContactActive(customerId, c.id, !c.active);
                        if (r.ok) {
                          toast.success(r.message ?? "Saved");
                          router.refresh();
                        } else toast.error(r.error);
                      })
                    }
                  >
                    {c.active ? "Archive" : "Restore"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {contacts.some((c) => !c.active) && (
        <div className="border-t border-line px-4 py-2 sm:px-5">
          <button className="text-sm text-muted hover:text-ink hover:underline" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived contacts" : "Show archived contacts"}
          </button>
        </div>
      )}
      {editing && (
        <ContactDialog
          customerId={customerId}
          contact={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

function ContactDialog({ customerId, contact, onClose, onSaved }: { customerId: string; contact: ContactRow | null; onClose: () => void; onSaved: () => void }) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(saveContact.bind(null, customerId, contact?.id ?? null), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      onSaved();
    },
  });
  const f = (name: string) => ({ id: `contact-${name}`, name, ...describedBy(`contact-${name}`, fieldError(name)) });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()} title={contact ? "Edit contact" : "Add contact"}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="contact-name" required error={fieldError("name")}>
            <Input {...f("name")} defaultValue={contact?.name} autoFocus />
          </Field>
          <Field label="Title / role" htmlFor="contact-title" error={fieldError("title")}>
            <Input {...f("title")} defaultValue={contact?.title} />
          </Field>
          <Field label="Email" htmlFor="contact-email" error={fieldError("email")}>
            <Input {...f("email")} type="email" defaultValue={contact?.email} />
          </Field>
          <Field label="Phone" htmlFor="contact-phone" error={fieldError("phone")}>
            <Input {...f("phone")} type="tel" defaultValue={contact?.phone} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-6">
          <Checkbox name="is_primary" defaultChecked={contact?.is_primary ?? false} label="Primary contact" />
          <Checkbox name="is_billing" defaultChecked={contact?.is_billing ?? false} label="Billing contact" />
        </div>
        <Field label="Notes" htmlFor="contact-notes" error={fieldError("notes")}>
          <Textarea {...f("notes")} defaultValue={contact?.notes} rows={2} />
        </Field>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save contact
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function SitesPanel({ customerId, sites, canEdit }: { customerId: string; sites: SiteRow[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<SiteRow | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const visible = sites.filter((s) => showArchived || s.active);

  return (
    <Card>
      <CardHeader
        title="Delivery / job sites"
        actions={
          canEdit && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              Add job site
            </Button>
          )
        }
      />
      {visible.length === 0 ? (
        <EmptyState icon={<MapPin className="size-6" />} title="No job sites" description="Add delivery addresses so they can be picked on quotes." className="py-8" />
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-semibold">
                  {s.label} {!s.active && <Badge>Archived</Badge>}
                </p>
                <p className="text-sm">
                  {s.line1}
                  {s.line2 ? `, ${s.line2}` : ""}
                  {s.city ? `, ${s.city}` : ""} {s.state} {s.postal_code}
                </p>
                {s.directions && <p className="mt-0.5 text-sm text-muted">{s.directions}</p>}
              </div>
              {canEdit && (
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await setSiteActive(customerId, s.id, !s.active);
                        if (r.ok) {
                          toast.success(r.message ?? "Saved");
                          router.refresh();
                        } else toast.error(r.error);
                      })
                    }
                  >
                    {s.active ? "Archive" : "Restore"}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {sites.some((s) => !s.active) && (
        <div className="border-t border-line px-4 py-2 sm:px-5">
          <button className="text-sm text-muted hover:text-ink hover:underline" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived sites" : "Show archived sites"}
          </button>
        </div>
      )}
      {editing && (
        <SiteDialog
          customerId={customerId}
          site={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

function SiteDialog({ customerId, site, onClose, onSaved }: { customerId: string; site: SiteRow | null; onClose: () => void; onSaved: () => void }) {
  const { pending, onSubmit, fieldError, formError } = useFormAction(saveSite.bind(null, customerId, site?.id ?? null), {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved");
      onSaved();
    },
  });
  const f = (name: string) => ({ id: `site-${name}`, name, ...describedBy(`site-${name}`, fieldError(name)) });
  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()} title={site ? "Edit job site" : "Add job site"}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <FormError message={formError} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
          <Field label="Site name" htmlFor="site-label" required error={fieldError("label")} className="sm:col-span-6" hint='For example "Route 30 parking lot" or "Home".'>
            <Input {...f("label")} defaultValue={site?.label} autoFocus />
          </Field>
          <Field label="Street address" htmlFor="site-line1" required error={fieldError("line1")} className="sm:col-span-4">
            <Input {...f("line1")} defaultValue={site?.line1} />
          </Field>
          <Field label="Line 2" htmlFor="site-line2" error={fieldError("line2")} className="sm:col-span-2">
            <Input {...f("line2")} defaultValue={site?.line2} />
          </Field>
          <Field label="City" htmlFor="site-city" error={fieldError("city")} className="sm:col-span-3">
            <Input {...f("city")} defaultValue={site?.city} />
          </Field>
          <Field label="State" htmlFor="site-state" error={fieldError("state")} className="sm:col-span-1">
            <Input {...f("state")} defaultValue={site?.state ?? "IN"} maxLength={2} className="uppercase" />
          </Field>
          <Field label="ZIP" htmlFor="site-postal_code" error={fieldError("postal_code")} className="sm:col-span-2">
            <Input {...f("postal_code")} defaultValue={site?.postal_code} inputMode="numeric" />
          </Field>
          <Field label="Directions / access notes" htmlFor="site-directions" error={fieldError("directions")} className="sm:col-span-6" hint="Gate codes, where to dump, access restrictions. Printed on driver tickets later.">
            <Textarea {...f("directions")} defaultValue={site?.directions} rows={3} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Save job site
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ArchiveCustomerButton({ customerId, active, name }: { customerId: string; active: boolean; name: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return (
    <>
      <Button variant={active ? "danger" : "secondary"} onClick={() => setOpen(true)}>
        {active ? "Archive" : "Reactivate"}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={active ? `Archive ${name}?` : `Reactivate ${name}?`}
        description={
          active
            ? "Archived customers are hidden from lists and cannot receive new quotes. Their history is kept."
            : "The customer will appear in lists and can be quoted again."
        }
        confirmLabel={active ? "Archive customer" : "Reactivate"}
        tone={active ? "danger" : "primary"}
        onConfirm={async () => {
          const r = await setCustomerActive(customerId, !active);
          if (!r.ok) return r.error;
          toast.success(r.message ?? "Saved");
          router.refresh();
        }}
      />
    </>
  );
}
