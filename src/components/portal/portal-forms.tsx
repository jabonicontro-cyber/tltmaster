"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateInput } from "@/components/ui/date-input";
import { Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { PasswordInput } from "@/components/ui/password-input";
import { useFormAction } from "@/components/ui/use-form-action";
import { acceptPortalInvite, requestPortalAccount, createSupportRequest, replyToSupport, requestQuote, respondToQuote, signInToPortal, voteOnArticle } from "@/app/portal/actions";

export function PortalLoginForm({ slug, next, company }: { slug: string; next?: string; company: string }) {
  const { pending, onSubmit, formError } = useFormAction(signInToPortal);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <FormError message={formError} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="next" value={next ?? ""} />
      <Field label="Email or username" htmlFor="email">
        <Input id="email" name="email" type="text" inputMode="email" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus className="h-12 text-base" />
      </Field>
      <Field label="Password" htmlFor="password">
        <PasswordInput id="password" name="password" autoComplete="current-password" required className="h-12 text-base" />
      </Field>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" name="shared_device" className="mt-0.5 size-5 rounded border-line accent-brand" />
        This is a shared computer (sign me out when the browser closes)
      </label>
      <Button type="submit" className="w-full" size="lg" loading={pending}>
        {pending ? "Signing in…" : "Sign In"}
      </Button>
      <details className="rounded-xl bg-surface p-3 text-sm text-ink">
        <summary className="cursor-pointer font-semibold">First time signing in, or forgot your password?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>If {company} gave you a username and a temporary password, type them here. You will then create your own password.</li>
          <li>Forgot your password, or the temporary one expired? Ask {company} for a new sign-in. Nobody there can see your password.</li>
        </ul>
      </details>
    </form>
  );
}

export function AcceptInviteForm({ token, email, signedInAs }: { token: string; email: string; signedInAs: string | null }) {
  const accept = useFormAction(acceptPortalInvite);
  const [sent, setSent] = useState<string | null>(null);
  const request = useFormAction(requestPortalAccount, { onSuccess: (r) => setSent(r.message ?? "Check your email.") });
  if (signedInAs) {
    return (
      <form onSubmit={accept.onSubmit} className="space-y-4">
        <FormError message={accept.formError} />
        <input type="hidden" name="token" value={token} />
        <p className="text-sm text-muted">You are signed in as <strong className="text-ink">{signedInAs}</strong>.</p>
        <Button type="submit" className="w-full" size="lg" loading={accept.pending}>Accept Invitation</Button>
      </form>
    );
  }
  if (sent) {
    return <p role="status" className="rounded-xl border border-line bg-surface p-3 text-sm text-ink">{sent}</p>;
  }
  return (
    <form onSubmit={request.onSubmit} className="space-y-4">
      <FormError message={request.formError} />
      <input type="hidden" name="token" value={token} />
      <Field label="Email" htmlFor="invite-email" hint="We send a sign-in link to this address. Opening it confirms it is yours.">
        <Input id="invite-email" value={email} readOnly disabled />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={request.pending}>Email Me a Sign-In Link</Button>
      <p className="text-xs text-muted">Already have an account with this email? Sign in first, then open the invitation link again.</p>
    </form>
  );
}

export function QuoteRequestForm({ slug, sites }: { slug: string; sites: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const { pending, onSubmit, formError, fieldError } = useFormAction(requestQuote, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Request sent.");
      form.current?.reset();
      router.refresh();
    },
  });
  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-4" aria-label="Request a quote">
      <FormError message={formError} />
      <input type="hidden" name="slug" value={slug} />
      <Field label="Material" htmlFor="material" required>
        <Input id="material" name="material" required maxLength={200} placeholder="e.g. Crushed limestone #57" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Quantity" htmlFor="quantity" error={fieldError("quantity")}>
          <Input id="quantity" name="quantity" inputMode="decimal" maxLength={20} />
        </Field>
        <Field label="Unit" htmlFor="unit">
          <Input id="unit" name="unit" maxLength={30} placeholder="tons, yards, loads" />
        </Field>
        <Field label="Needed by" htmlFor="requested_date">
          <DateInput id="requested_date" name="requested_date" />
        </Field>
      </div>
      {sites.length ? (
        <Field label="Delivery site" htmlFor="site_id">
          <Select id="site_id" name="site_id" defaultValue="">
            <option value="">A new or different site</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.label}</option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="New site address" htmlFor="site_text" hint="Only if the site is not in the list.">
        <Input id="site_text" name="site_text" maxLength={300} />
      </Field>
      <Field label="Notes" htmlFor="notes">
        <Textarea id="notes" name="notes" rows={3} maxLength={2000} />
      </Field>
      <Button type="submit" loading={pending}>Send Request</Button>
    </form>
  );
}

export function QuoteResponseForm({ slug, quote }: { slug: string; quote: string }) {
  const router = useRouter();
  const [answer, setAnswer] = useState<"accept" | "decline">("accept");
  const { pending, onSubmit, formError, fieldError } = useFormAction(respondToQuote, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Thank you.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Answer this quote">
      <FormError message={formError} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="quote" value={quote} />
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-2 text-sm font-semibold text-ink">Your answer</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="answer" value="accept" checked={answer === "accept"} onChange={() => setAnswer("accept")} className="size-4 accent-brand" /> Accept this quote</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="answer" value="decline" checked={answer === "decline"} onChange={() => setAnswer("decline")} className="size-4 accent-brand" /> Decline</label>
      </fieldset>
      <Field label="Your name" htmlFor="name" required error={fieldError("name")} hint="Recorded with your answer.">
        <Input id="name" name="name" required maxLength={120} autoComplete="name" />
      </Field>
      <Field label={answer === "accept" ? "Anything we should know?" : "Reason (optional)"} htmlFor="note">
        <Textarea id="note" name="note" rows={2} maxLength={1000} />
      </Field>
      <Button type="submit" variant={answer === "accept" ? "primary" : "secondary"} loading={pending}>
        {answer === "accept" ? "Accept Quote" : "Decline Quote"}
      </Button>
    </form>
  );
}

export function SupportForm({ slug, orders, defaultOrder }: { slug: string; orders: Array<{ id: string; number: string }>; defaultOrder?: string }) {
  const { pending, onSubmit, formError } = useFormAction(createSupportRequest);
  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="New support request">
      <FormError message={formError} />
      <input type="hidden" name="slug" value={slug} />
      <Field label="Subject" htmlFor="subject" required>
        <Input id="subject" name="subject" required maxLength={160} />
      </Field>
      {orders.length ? (
        <Field label="About an order" htmlFor="order">
          <Select id="order" name="order" defaultValue={defaultOrder ?? ""}>
            <option value="">Not about a specific order</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>Order {o.number}</option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Message" htmlFor="message" required>
        <Textarea id="message" name="message" rows={5} required minLength={5} maxLength={4000} />
      </Field>
      <Button type="submit" loading={pending}>Send</Button>
    </form>
  );
}

export function SupportReplyForm({ slug, request }: { slug: string; request: string }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const { pending, onSubmit, formError } = useFormAction(replyToSupport, {
    onSuccess: () => {
      form.current?.reset();
      router.refresh();
    },
  });
  return (
    <form ref={form} onSubmit={onSubmit} className="space-y-3" aria-label="Reply">
      <FormError message={formError} />
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="request" value={request} />
      <Field label="Reply" htmlFor="body">
        <Textarea id="body" name="body" rows={3} required maxLength={4000} />
      </Field>
      <Button type="submit" variant="secondary" loading={pending}>Send Reply</Button>
    </form>
  );
}

export function ArticleVote({ slug, article }: { slug: string; article: string }) {
  const [done, setDone] = useState(false);
  const { pending, onSubmit } = useFormAction(voteOnArticle, { onSuccess: () => setDone(true) });
  if (done) return <p className="text-sm text-muted">Thanks for the feedback.</p>;
  // One small form per answer: a form's data never includes which button was pressed.
  const vote = (helpful: "yes" | "no", label: string) => (
    <form onSubmit={onSubmit}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="article" value={article} />
      <input type="hidden" name="helpful" value={helpful} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>{label}</Button>
    </form>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">Did this help?</span>
      {vote("yes", "Yes")}
      {vote("no", "No")}
    </div>
  );
}
