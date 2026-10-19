"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { isValidUsername, normalizeUsername } from "@/lib/usernames";
import {
  checkPortalUsername, createPortalSignIn, emailPortalSetup, recordPortalHandoff, type CreatedPortalSignIn,
} from "@/app/(app)/customer-portal/account-actions";
import { CredentialDelivery } from "./credential-delivery";
import { suggestUsername } from "./sign-in-wizard";

type Contact = { id: string; customer_id: string; name: string; email: string };

/**
 * A username sign-in for one contact of one customer (docs/ACCOUNT_PROVISIONING.md §4): pick the customer, an existing
 * contact or a new one (no duplicate contacts are created), a username, then review and hand over. The request key
 * makes a retry continue the same sign-in.
 */
export function PortalSignInForm({ customers, contacts, taken, companyName, emailConfigured, emailReason }: {
  customers: Array<{ id: string; name: string }>;
  contacts: Contact[];
  /** Contacts that already have an active username sign-in. */
  taken: string[];
  companyName: string;
  emailConfigured: boolean;
  emailReason?: string;
}) {
  const router = useRouter();
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [step, setStep] = useState<"details" | "review" | "done">("details");
  const [customer, setCustomer] = useState("");
  const [contact, setContact] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [checked, setChecked] = useState<{ for: string; valid: boolean; available: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<CreatedPortalSignIn | null>(null);
  const check = useRef(0);

  const choices = contacts.filter((c) => c.customer_id === customer);
  const chosen = choices.find((c) => c.id === contact) ?? null;
  const personName = chosen?.name ?? name;
  const normalized = normalizeUsername(username);
  const wellFormed = Boolean(normalized) && isValidUsername(normalized);
  useEffect(() => {
    if (!wellFormed) return;
    const n = ++check.current;
    const t = setTimeout(async () => {
      const r = await checkPortalUsername(normalized).catch(() => null);
      if (n === check.current) setChecked(r ? { for: normalized, ...r } : null);
    }, 350);
    return () => clearTimeout(t);
  }, [normalized, wellFormed]);
  const availability: { checking: boolean; valid?: boolean; available?: boolean } = !normalized
    ? { checking: false }
    : !wellFormed
      ? { checking: false, valid: false }
      : checked?.for === normalized
        ? { checking: false, valid: checked.valid, available: checked.available }
        : { checking: true };

  function suggestFrom(n: string) {
    if (!usernameTouched) setUsername(suggestUsername(n));
  }

  function toReview() {
    const errs: Record<string, string> = {};
    if (!customer) errs.customer = "Choose a customer.";
    if (contact && taken.includes(contact)) errs.contact = "This contact already has a portal sign-in. Reissue it from the list below.";
    if (!contact && name.trim().length < 2) errs.contact_name = "Enter the person's name.";
    if (!contact && email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.contact_email = "Enter a valid email or leave it empty.";
    if (!isValidUsername(normalized)) errs.username = "3–32 letters, digits, dots or hyphens; start and end with a letter or digit.";
    else if (availability.available === false) errs.username = "That username is taken. Choose another.";
    setFieldErrors(errs);
    if (Object.keys(errs).length === 0) setStep("review");
  }

  async function create() {
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.set("request_key", requestKey);
    fd.set("customer", customer);
    fd.set("contact", contact);
    fd.set("contact_name", contact ? "" : name.trim());
    fd.set("contact_email", contact ? "" : email.trim());
    fd.set("username", normalized);
    try {
      const r = await createPortalSignIn(fd);
      if (!r.ok) {
        setError(r.error);
        if (r.fieldErrors) {
          setFieldErrors(r.fieldErrors);
          setStep("details");
        }
        return;
      }
      setCreated(r.data);
      setStep("done");
    } catch {
      setError("The server could not be reached. Nothing was lost: try Create again — it continues the same sign-in.");
    } finally {
      setPending(false);
    }
  }

  if (step === "done" && created) {
    return (
      <CredentialDelivery
        c={{ kind: "portal", personName: created.personName, companyName, username: created.username, loginUrl: created.loginUrl, temporaryPassword: created.temporaryPassword, expiresAt: created.expiresAt }}
        email={emailConfigured && created.email ? { available: true, to: created.email } : { available: false, reason: emailConfigured ? "Add the contact's email in Customers to send a setup link." : emailReason }}
        onEmail={() => emailPortalSetup(created.userId)}
        onRecord={(channel) => recordPortalHandoff(created.userId, channel)}
        onDone={() => {
          setCreated(null);
          setStep("details");
          setCustomer(""); setContact(""); setName(""); setEmail(""); setUsername(""); setUsernameTouched(false);
          setRequestKey(crypto.randomUUID());
          router.refresh();
        }}
      />
    );
  }

  if (step === "review") {
    return (
      <div className="space-y-4">
        <FormError message={error} />
        <h3 className="text-base font-bold text-ink">Check before creating</h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">Customer</dt><dd className="font-semibold text-ink">{customers.find((c) => c.id === customer)?.name}</dd></div>
          <div><dt className="text-muted">Person</dt><dd className="font-semibold text-ink">{personName}{chosen ? "" : " (new contact)"}</dd></div>
          <div><dt className="text-muted">Username</dt><dd className="font-mono font-semibold text-ink">{normalized}</dd></div>
          <div><dt className="text-muted">Email</dt><dd className="text-ink">{(chosen ? chosen.email : email) || "None (print or copy the instructions)"}</dd></div>
        </dl>
        <p className="text-sm text-muted">
          They will see only this customer&apos;s orders, deliveries, quotes and requests in your portal. A portal sign-in never opens your workspace.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void create()} loading={pending}>Create Sign-in</Button>
          <Button variant="secondary" onClick={() => setStep("details")} disabled={pending}>Back</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <FormError message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer" htmlFor="signin_customer" required error={fieldErrors.customer}>
          <Select id="signin_customer" value={customer} onChange={(e) => { setCustomer(e.target.value); setContact(""); }}>
            <option value="">Choose…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Contact" htmlFor="signin_contact" error={fieldErrors.contact} hint="An existing contact, or add the person below.">
          <Select id="signin_contact" value={contact} disabled={!customer} onChange={(e) => {
            setContact(e.target.value);
            const c = choices.find((x) => x.id === e.target.value);
            if (c) suggestFrom(c.name);
          }}>
            <option value="">New contact</option>
            {choices.map((c) => <option key={c.id} value={c.id} disabled={taken.includes(c.id)}>{c.name}{taken.includes(c.id) ? " (has a sign-in)" : ""}</option>)}
          </Select>
        </Field>
        {!contact ? (
          <>
            <Field label="Person's name" htmlFor="signin_name" required error={fieldErrors.contact_name}>
              <Input id="signin_name" value={name} maxLength={120} onChange={(e) => { setName(e.target.value); suggestFrom(e.target.value); }} />
            </Field>
            <Field label="Their email (optional)" htmlFor="signin_email" error={fieldErrors.contact_email} hint="Only to email a setup link. Not needed to sign in.">
              <Input id="signin_email" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </>
        ) : null}
        <Field label="Username" htmlFor="signin_username" required error={fieldErrors.username} hint="What they type to sign in. Lowercase letters, digits, dots or hyphens (3–32).">
          <Input id="signin_username" value={username} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby="signin-username-status"
            onChange={(e) => { setUsername(e.target.value.toLowerCase().replace(/\s/g, "")); setUsernameTouched(true); }} />
        </Field>
        <p id="signin-username-status" role="status" className="self-end pb-2 text-sm">
          {!normalized ? null : availability.checking ? <span className="text-muted">Checking…</span>
            : availability.valid === false ? <span className="text-critical">Not a valid username.</span>
            : availability.available === true ? <span className="inline-flex items-center gap-1 text-ink"><CheckCircle2 className="size-4 text-brand-fg" aria-hidden /> {normalized} is available</span>
            : availability.available === false ? <span className="inline-flex items-center gap-1 text-critical"><CircleAlert className="size-4" aria-hidden /> {normalized} is taken</span> : null}
        </p>
      </div>
      <Button onClick={toReview} disabled={availability.checking}>Review</Button>
    </div>
  );
}
