"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import type { ActionResult } from "@/lib/action-result";
import {
  createTrackingLink, handleQuoteResponse, invitePortalCustomer, replyToPortalRequest, revokePortalAccount, revokeTrackingLink, savePortalSettings,
  saveHelpArticle, updateQuoteRequest,
} from "@/app/(app)/customer-portal/actions";

function useRefreshing<T>(action: (fd: FormData) => Promise<ActionResult<T>>, after?: (r: { ok: true; data: T; message?: string }) => void) {
  const router = useRouter();
  return useFormAction(action, {
    onSuccess: (r) => {
      if (r.message) toast.success(r.message);
      after?.(r);
      router.refresh();
    },
  });
}

export type PortalSettingsValues = {
  enabled: boolean; public_page: boolean; display_name: string; welcome: string; contact_email: string; contact_phone: string; hours: string;
  feature_orders: boolean; feature_quotes: boolean; feature_documents: boolean; feature_support: boolean; feature_help: boolean; feature_tracking: boolean;
};

export function PortalSettingsForm({ values, entitled, canEdit }: { values: PortalSettingsValues; entitled: boolean; canEdit: boolean }) {
  const { pending, onSubmit, formError } = useRefreshing(savePortalSettings);
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <FormError message={formError} />
      <fieldset disabled={!canEdit} className="space-y-5">
        <div className="flex flex-col gap-2">
          <Checkbox name="enabled" defaultChecked={values.enabled} disabled={!entitled} label={<span><strong>Portal on</strong> — invited customers can sign in.</span>} />
          <Checkbox name="public_page" defaultChecked={values.public_page} label="Public page — anyone with the link sees your welcome, contact details and published help (never orders or quotes)." />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name shown to customers" htmlFor="display_name" hint="Empty: your company name.">
            <Input id="display_name" name="display_name" defaultValue={values.display_name} maxLength={120} />
          </Field>
          <Field label="Contact email" htmlFor="contact_email" hint="Empty: the email in Company settings.">
            <Input id="contact_email" name="contact_email" type="email" defaultValue={values.contact_email} maxLength={200} />
          </Field>
          <Field label="Contact phone" htmlFor="contact_phone" hint="Empty: the phone in Company settings.">
            <Input id="contact_phone" name="contact_phone" defaultValue={values.contact_phone} maxLength={40} />
          </Field>
          <Field label="Hours" htmlFor="hours">
            <Textarea id="hours" name="hours" defaultValue={values.hours} rows={2} maxLength={500} placeholder="Mon–Fri 6:30 AM – 5 PM" />
          </Field>
        </div>
        <Field label="Welcome message" htmlFor="welcome">
          <Textarea id="welcome" name="welcome" defaultValue={values.welcome} rows={3} maxLength={2000} />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-ink">What customers can use</legend>
          <Checkbox name="feature_orders" defaultChecked={values.feature_orders} label="Orders and delivery status" />
          <Checkbox name="feature_documents" defaultChecked={values.feature_documents} label="Delivery tickets (customer copy: no driver or truck details)" />
          <Checkbox name="feature_quotes" defaultChecked={values.feature_quotes} label="Quotes: read sent quotes, answer them, request new ones" />
          <Checkbox name="feature_support" defaultChecked={values.feature_support} label="Support requests" />
          <Checkbox name="feature_help" defaultChecked={values.feature_help} label="Help articles" />
          <Checkbox name="feature_tracking" defaultChecked={values.feature_tracking} label="Shareable tracking links for orders (expire; can be turned off)" />
        </fieldset>
        <p className="text-sm text-muted">Invoices and online payment are not offered in the portal: invoices come from your accounting system and no payment provider is connected.</p>
        {canEdit ? <Button type="submit" loading={pending}>Save Portal Settings</Button> : null}
      </fieldset>
    </form>
  );
}

export function InviteForm({ customers, contacts }: { customers: Array<{ id: string; name: string }>; contacts: Array<{ id: string; customer_id: string; name: string; email: string }> }) {
  const [customer, setCustomer] = useState("");
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<{ link: string; expires: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const forCustomer = useMemo(() => contacts.filter((c) => c.customer_id === customer && c.email), [contacts, customer]);
  const { pending, onSubmit, formError } = useRefreshing(invitePortalCustomer, (r) => {
    setLink(r.data);
    form.current?.reset();
    setCustomer("");
    setEmail("");
  });
  const full = link ? `${typeof window === "undefined" ? "" : window.location.origin}${link.link}` : "";
  return (
    <div className="space-y-4">
      <form ref={form} onSubmit={onSubmit} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]" aria-label="Invite a customer contact">
        <FormError message={formError} />
        <Field label="Customer" htmlFor="invite-customer">
          <Select id="invite-customer" name="customer" required value={customer} onChange={(e) => setCustomer(e.target.value)}>
            <option value="">Choose…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Contact" htmlFor="invite-contact">
          <Select id="invite-contact" name="contact" defaultValue="" onChange={(e) => setEmail(forCustomer.find((c) => c.id === e.target.value)?.email ?? email)} disabled={!forCustomer.length}>
            <option value="">{forCustomer.length ? "Choose a contact…" : "No contacts with email"}</option>
            {forCustomer.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Email" htmlFor="invite-email">
          <Input id="invite-email" name="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit" loading={pending}>Create Invitation</Button>
      </form>
      {link ? (
        <div role="status" className="space-y-2 rounded-md border border-line bg-surface p-3 text-sm">
          <p className="font-semibold text-ink">Send this one-time link to the customer yourself. It works once and expires in 7 days.</p>
          <div className="flex flex-wrap gap-2">
            <Input readOnly value={full} aria-label="Invitation link" className="min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="secondary" onClick={() => navigator.clipboard.writeText(full).then(() => toast.success("Link copied."))}>Copy</Button>
          </div>
          <p className="text-muted">The link is not shown again. Taviron does not email it.</p>
        </div>
      ) : null}
    </div>
  );
}

export function RevokeAccountButton({ account, email }: { account: string; email: string }) {
  const { pending, onSubmit } = useRefreshing(revokePortalAccount);
  return (
    <form onSubmit={(e) => (window.confirm(`Remove portal access for ${email}?`) ? onSubmit(e) : e.preventDefault())}>
      <input type="hidden" name="account" value={account} />
      <Button type="submit" size="sm" variant="secondary" loading={pending}>Remove Access</Button>
    </form>
  );
}

export function StaffReplyForm({ request }: { request: string }) {
  const form = useRef<HTMLFormElement>(null);
  const { pending, onSubmit, formError } = useRefreshing(replyToPortalRequest, () => form.current?.reset());
  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-2">
      <FormError message={formError} />
      <input type="hidden" name="request" value={request} />
      <label htmlFor={`reply-${request}`} className="sr-only">Reply</label>
      <Textarea id={`reply-${request}`} name="body" rows={2} maxLength={4000} placeholder="Reply to the customer…" />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" loading={pending}>Send Reply</Button>
        <Checkbox name="close" label="Close the request" />
      </div>
    </form>
  );
}

export function QuoteRequestForm({ request, status, quotes }: { request: string; status: string; quotes: Array<{ id: string; number: string }> }) {
  const { pending, onSubmit, formError } = useRefreshing(updateQuoteRequest);
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <FormError message={formError} />
      <input type="hidden" name="request" value={request} />
      <Field label="Status" htmlFor={`st-${request}`}>
        <Select id={`st-${request}`} name="status" defaultValue={status}>
          <option value="new">Received</option>
          <option value="reviewing">Being priced</option>
          <option value="quoted">Quoted</option>
          <option value="declined">Not quoted</option>
        </Select>
      </Field>
      {quotes.length ? (
        <Field label="Quote" htmlFor={`q-${request}`}>
          <Select id={`q-${request}`} name="quote" defaultValue="">
            <option value="">—</option>
            {quotes.map((q) => (
              <option key={q.id} value={q.id}>{q.number}</option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Button type="submit" size="sm" variant="secondary" loading={pending}>Update</Button>
    </form>
  );
}

export function QuoteResponseButtons({ response, accept }: { response: string; accept: boolean }) {
  const confirm = useRefreshing(handleQuoteResponse);
  const dismiss = useRefreshing(handleQuoteResponse);
  return (
    <div className="flex flex-wrap gap-2">
      <FormError message={confirm.formError ?? dismiss.formError} />
      <form onSubmit={confirm.onSubmit}>
        <input type="hidden" name="response" value={response} />
        <input type="hidden" name="confirm" value="yes" />
        <Button type="submit" size="sm" loading={confirm.pending}>{accept ? "Confirm Acceptance" : "Confirm Decline"}</Button>
      </form>
      <form onSubmit={dismiss.onSubmit}>
        <input type="hidden" name="response" value={response} />
        <input type="hidden" name="confirm" value="no" />
        <Button type="submit" size="sm" variant="secondary" loading={dismiss.pending}>Dismiss</Button>
      </form>
    </div>
  );
}

export function HelpArticleForm({ article }: { article?: { id: string; title: string; category: string; body: string; status: string } }) {
  const form = useRef<HTMLFormElement>(null);
  const { pending, onSubmit, formError } = useRefreshing(saveHelpArticle, () => {
    if (!article) form.current?.reset();
  });
  const key = article?.id ?? "new";
  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-3">
      <FormError message={formError} />
      {article ? <input type="hidden" name="id" value={article.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Title" htmlFor={`t-${key}`}>
          <Input id={`t-${key}`} name="title" defaultValue={article?.title} required maxLength={160} />
        </Field>
        <Field label="Category" htmlFor={`c-${key}`}>
          <Input id={`c-${key}`} name="category" defaultValue={article?.category ?? "General"} maxLength={60} />
        </Field>
      </div>
      <Field label="Article" htmlFor={`b-${key}`} hint="Plain text. Only your approved policies and procedures; customers read exactly this.">
        <Textarea id={`b-${key}`} name="body" defaultValue={article?.body} rows={5} maxLength={20000} />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Status" htmlFor={`s-${key}`}>
          <Select id={`s-${key}`} name="status" defaultValue={article?.status ?? "draft"}>
            <option value="draft">Draft (not visible)</option>
            <option value="published">Published</option>
            <option value="retired">Retired (hidden)</option>
          </Select>
        </Field>
        <Button type="submit" variant="secondary" loading={pending}>{article ? "Save" : "Add Article"}</Button>
      </div>
    </form>
  );
}

export function TrackingLinks({ order, links, enabled }: { order: string; links: Array<{ id: string; expires_at: string; created_at: string; live: boolean }>; enabled: boolean }) {
  const [created, setCreated] = useState<string | null>(null);
  const create = useRefreshing(createTrackingLink, (r) => setCreated(`${window.location.origin}${r.data.link}`));
  const revoke = useRefreshing(revokeTrackingLink);
  const live = links.filter((l) => l.live);
  const day = (d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return (
    <div className="space-y-3 text-sm">
      {!enabled ? <p className="text-muted">Tracking links are off in Customer Portal settings.</p> : null}
      <FormError message={create.formError ?? revoke.formError} />
      {enabled ? (
        <form onSubmit={create.onSubmit} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="order" value={order} />
          <Field label="Valid for" htmlFor={`days-${order}`}>
            <Select id={`days-${order}`} name="days" defaultValue="14">
              <option value="3">3 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </Select>
          </Field>
          <Button type="submit" size="sm" variant="secondary" loading={create.pending}>Create Tracking Link</Button>
        </form>
      ) : null}
      {created ? (
        <div role="status" className="space-y-2 rounded-md bg-surface p-3">
          <p className="font-semibold text-ink">Share this link. It shows only status, schedule and confirmed quantities, and is not shown again.</p>
          <div className="flex flex-wrap gap-2">
            <Input readOnly value={created} aria-label="Tracking link" className="min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="secondary" onClick={() => navigator.clipboard.writeText(created).then(() => toast.success("Link copied."))}>Copy</Button>
          </div>
        </div>
      ) : null}
      {live.length ? (
        <ul className="divide-y divide-line">
          {live.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 py-2">
              <span className="text-muted">Created {day(l.created_at)} · expires {day(l.expires_at)}</span>
              <form onSubmit={revoke.onSubmit}>
                <input type="hidden" name="link" value={l.id} />
                <input type="hidden" name="order" value={order} />
                <Button type="submit" size="sm" variant="ghost" loading={revoke.pending}>Turn Off</Button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
