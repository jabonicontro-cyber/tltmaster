"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Select } from "@/components/ui/form";
import { PhoneInput } from "@/components/ui/phone-input";
import type { RolePreset } from "@/lib/accounts";
import type { AppRole } from "@/lib/permissions";
import { isValidUsername, normalizeUsername } from "@/lib/usernames";
import { checkUsername, createEmployeeSignIn, emailEmployeeSetup, recordInstructionsHandoff, type CreatedSignIn } from "@/app/(app)/employees/account-actions";
import { CredentialDelivery } from "./credential-delivery";

type RoleOption = { role: AppRole; label: string; permissions: string[] };

/** A username suggestion from a name: "Sam O'Neil" → "sam.oneil". */
function suggestUsername(name: string): string {
  const parts = name.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s.-]/gu, "").replace(/[^a-z0-9\s.-]/g, "").trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? `${parts[0]}.${parts[parts.length - 1]}` : (parts[0] ?? "");
  return s.slice(0, 32).replace(/^[.-]+|[.-]+$/g, "");
}

/**
 * Add a person with a username sign-in in three steps: details, review (role, permissions, bases, status), then the
 * delivery panel. The request key makes a double click or a retry safe: the server resumes the same sign-in.
 */
export function SignInWizard({ presets, roles, bases, employee, companyName, emailConfigured, emailReason }: {
  presets: RolePreset[];
  roles: RoleOption[];
  bases: Array<{ id: string; label: string }>;
  employee: { id: string; full_name: string; job_title: string; work_email: string; work_phone: string } | null;
  companyName: string;
  emailConfigured: boolean;
  emailReason?: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"details" | "review" | "done">("details");
  const [requestKey] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(employee?.full_name ?? "");
  const [jobTitle, setJobTitle] = useState(employee?.job_title ?? "");
  const [username, setUsername] = useState(() => (employee ? suggestUsername(employee.full_name) : ""));
  const [usernameTouched, setUsernameTouched] = useState(Boolean(employee));
  const [email, setEmail] = useState(employee?.work_email ?? "");
  const [phone, setPhone] = useState(employee?.work_phone ?? "");
  const [preset, setPreset] = useState<string>("driver");
  const [role, setRole] = useState<AppRole>("driver");
  const [chosenBases, setChosenBases] = useState<string[]>([]);
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [checked, setChecked] = useState<{ for: string; valid: boolean; available: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<CreatedSignIn | null>(null);
  const check = useRef(0);

  const normalized = normalizeUsername(username);
  const wellFormed = Boolean(normalized) && isValidUsername(normalized);
  useEffect(() => {
    if (!wellFormed) return;
    const n = ++check.current;
    const t = setTimeout(async () => {
      const r = await checkUsername(normalized).catch(() => null);
      if (n === check.current) setChecked(r ? { for: normalized, ...r } : null);
    }, 350);
    return () => clearTimeout(t);
  }, [normalized, wellFormed]);
  // What the status line shows, derived from the last answer for exactly this username.
  const availability: { checking: boolean; valid?: boolean; available?: boolean } = !normalized
    ? { checking: false }
    : !wellFormed
      ? { checking: false, valid: false }
      : checked?.for === normalized
        ? { checking: false, valid: checked.valid, available: checked.available }
        : { checking: true };

  const roleOption = useMemo(() => roles.find((r) => r.role === role), [roles, role]);
  const presetInfo = presets.find((p) => p.id === preset);

  function choosePreset(id: string) {
    setPreset(id);
    const p = presets.find((x) => x.id === id);
    if (p) {
      if (roles.some((r) => r.role === p.role)) setRole(p.role);
      if (!jobTitle || presets.some((x) => x.jobTitle === jobTitle)) setJobTitle(p.jobTitle);
    }
  }

  function toReview() {
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.full_name = "Enter the person's name.";
    if (!isValidUsername(normalized)) errs.username = "3–32 letters, digits, dots or hyphens; start and end with a letter or digit.";
    else if (availability.available === false) errs.username = "That username is taken. Choose another.";
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.email = "Enter a valid email or leave it empty.";
    setFieldErrors(errs);
    if (Object.keys(errs).length === 0) setStep("review");
  }

  async function create() {
    setPending(true);
    setError(null);
    const fd = new FormData();
    fd.set("request_key", requestKey);
    fd.set("employee_id", employee?.id ?? "");
    fd.set("full_name", name);
    fd.set("job_title", jobTitle);
    fd.set("username", normalized);
    fd.set("email", email.trim());
    fd.set("phone", phone);
    fd.set("role", role);
    fd.set("status", status);
    fd.set("bases", chosenBases.join(","));
    try {
      const r = await createEmployeeSignIn(fd);
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
        c={{ kind: "employee", personName: created.personName, companyName, username: created.username, loginUrl: created.loginUrl, temporaryPassword: created.temporaryPassword, expiresAt: created.expiresAt }}
        email={emailConfigured && email ? { available: true, to: email } : { available: false, reason: emailConfigured ? "Add the person's email to send a setup link." : emailReason }}
        onEmail={() => emailEmployeeSetup(created.userId)}
        onRecord={(channel) => recordInstructionsHandoff(created.userId, channel)}
        onDone={() => { setCreated(null); router.push(`/employees/${created.employeeId}`); }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <ol className="flex gap-2 text-sm" aria-label="Steps">
        {["Details", "Review", "Hand over"].map((s, i) => (
          <li key={s} aria-current={(step === "details" && i === 0) || (step === "review" && i === 1) ? "step" : undefined}
            className={`rounded-full px-3 py-1 font-semibold ${(step === "details" && i === 0) || (step === "review" && i === 1) ? "bg-strong text-white" : "bg-surface text-muted"}`}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <FormError message={error} />

      {step === "details" ? (
        <div className="space-y-5 rounded-lg border border-line bg-card p-4 sm:p-6">
          <fieldset>
            <legend className="text-sm font-semibold text-ink">What do they do?</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-4">
              {presets.map((p) => (
                <label key={p.id} className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${preset === p.id ? "border-strong bg-surface font-semibold" : "border-line"}`}>
                  <input type="radio" name="preset" value={p.id} checked={preset === p.id} onChange={() => choosePreset(p.id)} className="size-4 accent-brand" />
                  {p.label}
                </label>
              ))}
            </div>
            {presetInfo ? <p className="mt-2 text-xs text-muted">After signing in they start on {presetInfo.lands}. Access comes from the role below, not from the job title.</p> : null}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="full_name" required error={fieldErrors.full_name}>
              <Input id="full_name" value={name} maxLength={120} onChange={(e) => { setName(e.target.value); if (!usernameTouched) setUsername(suggestUsername(e.target.value)); }} />
            </Field>
            <Field label="Job title" htmlFor="job_title">
              <Input id="job_title" value={jobTitle} maxLength={80} onChange={(e) => setJobTitle(e.target.value)} />
            </Field>
            <Field label="Username" htmlFor="username" required error={fieldErrors.username}
              hint="What they type to sign in. Lowercase letters, digits, dots or hyphens (3–32).">
              <Input id="username" value={username} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                onChange={(e) => { setUsername(e.target.value.toLowerCase().replace(/\s/g, "")); setUsernameTouched(true); }} aria-describedby="username-status" />
            </Field>
            <p id="username-status" role="status" className="self-end pb-2 text-sm">
              {!normalized ? null : availability.checking ? <span className="text-muted">Checking…</span>
                : availability.valid === false ? <span className="text-critical">Not a valid username.</span>
                : availability.available === true ? <span className="inline-flex items-center gap-1 text-ink"><CheckCircle2 className="size-4 text-brand-fg" aria-hidden /> {normalized} is available</span>
                : availability.available === false ? <span className="inline-flex items-center gap-1 text-critical"><CircleAlert className="size-4" aria-hidden /> {normalized} is taken</span> : null}
            </p>
            <Field label="Email (optional)" htmlFor="email" error={fieldErrors.email} hint="Their own address, if they have one. Only used to email a setup link. Not needed to sign in.">
              <Input id="email" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Phone (optional)" htmlFor="phone">
              <PhoneInput id="phone" value={phone} onValueChange={setPhone} />
            </Field>
            <Field label="Role" htmlFor="role" required hint="Decides what they can see and do (Settings → Roles).">
              <Select id="role" value={role} onChange={(e) => setRole(e.target.value as AppRole)}>
                {roles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
              </Select>
            </Field>
            <Field label="Sign-in status" htmlFor="status">
              <Select id="status" value={status} onChange={(e) => setStatus(e.target.value as "active" | "inactive")}>
                <option value="active">On — they can sign in after setup</option>
                <option value="inactive">Off for now — turn it on later</option>
              </Select>
            </Field>
          </div>
          {bases.length > 1 ? (
            <fieldset>
              <legend className="text-sm font-semibold text-ink">Bases they work from</legend>
              <p className="text-xs text-muted">None ticked = every base.</p>
              <div className="mt-2 flex flex-wrap gap-3">
                {bases.map((b) => (
                  <label key={b.id} className="flex min-h-11 items-center gap-2 text-sm text-ink">
                    <input type="checkbox" checked={chosenBases.includes(b.id)} onChange={(e) => setChosenBases(e.target.checked ? [...chosenBases, b.id] : chosenBases.filter((x) => x !== b.id))} className="size-4 rounded border-line accent-brand" />
                    {b.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={toReview} disabled={availability.checking}>Review</Button>
            <Link href="/employees" className="inline-flex items-center px-3 text-sm font-semibold text-muted hover:text-ink">Cancel</Link>
          </div>
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-line bg-card p-4 sm:p-6">
          <h2 className="text-base font-bold text-ink">Check before creating</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Name</dt><dd className="font-semibold text-ink">{name}</dd></div>
            <div><dt className="text-muted">Username</dt><dd className="font-mono font-semibold text-ink">{normalized}</dd></div>
            <div><dt className="text-muted">Job title</dt><dd className="text-ink">{jobTitle || "—"}</dd></div>
            <div><dt className="text-muted">Email</dt><dd className="text-ink">{email || "None (print or copy the instructions)"}</dd></div>
            <div><dt className="text-muted">Bases</dt><dd className="text-ink">{chosenBases.length ? bases.filter((b) => chosenBases.includes(b.id)).map((b) => b.label).join(", ") : "Every base"}</dd></div>
            <div><dt className="text-muted">Sign-in</dt><dd className="text-ink">{status === "active" ? "On after setup" : "Off until you turn it on"}</dd></div>
          </dl>
          <div>
            <h3 className="text-sm font-semibold text-ink">Role: {roleOption?.label}</h3>
            {roleOption?.permissions.length ? (
              <ul className="mt-1 grid list-disc gap-x-6 pl-5 text-sm text-ink sm:grid-cols-2">
                {roleOption.permissions.map((p) => <li key={p}>{p}</li>)}
              </ul>
            ) : <p className="text-sm text-muted">No permissions listed for this role.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void create()} loading={pending}>Create Sign-in</Button>
            <Button variant="secondary" onClick={() => setStep("details")} disabled={pending}>Back</Button>
          </div>
        </div>
      )}
    </div>
  );
}
