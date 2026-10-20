"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Download, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, FormError, Input, Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/states";
import type { ActionResult } from "@/lib/action-result";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/dates";
import {
  CHECK_STATUS_LABEL, DEFAULT_WELCOME_BODY, DEFAULT_WELCOME_SUBJECT, DISPATCH_RULES, ENFORCEMENT_LABEL, GO_LIVE_ITEMS, GO_LIVE_STATUS_LABEL,
  INTEGRATIONS, QUESTIONNAIRE, goLiveBlockers, questionnaireMissing, renderWelcome,
  type CheckStatus, type Enforcement, type GoLiveStatus, type KitForm, type KitSectionKey, type WelcomeValues,
} from "@/lib/onboarding/kit";
import type { KitState } from "@/server/data/onboarding-kit";

type Data = Record<string, unknown>;
type SaveFn = (input: { form: KitForm; data: Data; version: number }) => Promise<ActionResult<{ version: number }>>;
type SignFn = (input: { name: string; title: string; version: number; confirm: true }) => Promise<ActionResult>;



const ENFORCEMENT_TONE: Record<Enforcement, "green" | "amber" | "gray" | "blue"> = { enforced: "green", manual: "amber", unsupported: "gray", untested: "blue" };
const GO_TONE: Record<GoLiveStatus, "gray" | "blue" | "green" | "critical-soft" | "amber"> = {
  not_started: "gray", in_progress: "blue", passed: "green", failed: "critical-soft", not_applicable: "gray", exception: "amber",
};

/** One editable form: its data, version, dirty state and save. */
function useForm(kit: KitState, form: KitForm, save: SaveFn) {
  const initial = (kit.forms[form]?.data ?? {}) as Data;
  const [data, setData] = useState<Data>(initial);
  const [version, setVersion] = useState(kit.forms[form]?.version ?? 0);
  const [saved, setSaved] = useState<Data>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(data) !== JSON.stringify(saved);
  return {
    data, setData, dirty, busy, error, version,
    set: (k: string, v: unknown) => setData((d) => ({ ...d, [k]: v })),
    async save() {
      setBusy(true);
      setError(null);
      const r = await save({ form, data, version }).catch(() => ({ ok: false as const, error: "The server could not be reached. Your answers are still here; try Save again." }));
      setBusy(false);
      if (!r.ok) { setError(r.error); return false; }
      setVersion(r.data.version);
      setSaved(data);
      toast.success(r.message ?? "Saved.");
      return true;
    },
  };
}

function SaveBar({ f, disabled, label = "Save" }: { f: ReturnType<typeof useForm>; disabled?: boolean; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
      <Button onClick={() => void f.save()} loading={f.busy} disabled={disabled || !f.dirty}>{label}</Button>
      <span className="text-xs text-muted" role="status">{f.dirty ? "Unsaved changes" : f.version ? `Saved (version ${f.version})` : "Not saved yet"}</span>
      <FormError message={f.error} />
    </div>
  );
}

export function KitWorkspace({ mode, kit, companyName, section, onboardingContact, supportContact, primaryContact, canSign, config, save, sign, templatesBase, checklistHref }: {
  mode: "company" | "taviron";
  kit: KitState;
  companyName: string;
  section: KitSectionKey;
  onboardingContact: string;
  supportContact: string;
  primaryContact: string;
  /** Company: the signed-in person is an owner. Taviron: always. */
  canSign: boolean;
  /** Taviron only: what this server has configured (booleans). */
  config?: Record<string, boolean>;
  save: SaveFn;
  sign: SignFn;
  templatesBase: string;
  checklistHref: string;
}) {
  const staff = mode === "taviron";
  const questionnaire = useForm(kit, "questionnaire", save);
  const worksheet = useForm(kit, "dispatch_worksheet", save);
  const integrations = useForm(kit, "integrations", save);
  const checks = useForm(kit, "integration_checks", save);
  const testing = useForm(kit, "testing", save);
  const goLive = useForm(kit, "go_live", save);
  const after = useForm(kit, "post_launch", save);
  const welcome = useForm(kit, "welcome_email", save);

  const missing = questionnaireMissing(questionnaire.data);
  const issues = (testing.data.issues as Issue[] | undefined) ?? [];
  const goItems = (goLive.data.items as Record<string, { status?: GoLiveStatus; note?: string }> | undefined) ?? {};
  const blockers = goLiveBlockers(goItems, issues);

  return (
    <div className="space-y-5">
      {section === "overview" && (
        <Overview kit={kit} missing={missing.length} blockers={blockers} issuesOpen={issues.filter((i) => i.status !== "resolved").length} checklistHref={checklistHref} staff={staff} />
      )}
      {section === "welcome" && (
        <WelcomeEmail f={welcome} staff={staff} values={{ company_name: companyName, primary_contact: primaryContact, onboarding_contact: onboardingContact, support_contact: supportContact }} />
      )}
      {section === "questionnaire" && <Questionnaire f={questionnaire} missing={missing} />}
      {section === "data" && <DataImport templatesBase={templatesBase} checklistHref={checklistHref} />}
      {section === "dispatch" && <Worksheet f={worksheet} />}
      {section === "integrations" && <Integrations f={integrations} checks={checks} staff={staff} config={config} />}
      {section === "testing" && <Testing f={testing} />}
      {section === "golive" && <GoLive f={goLive} kit={kit} staff={staff} blockers={blockers} canSign={canSign} sign={sign} />}
      {section === "after" && <After f={after} live={kit.lifecycle?.stage === "live"} />}
    </div>
  );
}

function Overview({ kit, missing, blockers, issuesOpen, checklistHref, staff }: { kit: KitState; missing: number; blockers: string[]; issuesOpen: number; checklistHref: string; staff: boolean }) {
  const steps: Array<{ label: string; state: string; tone: "green" | "amber" | "gray" | "blue" }> = [
    { label: "Setup questionnaire", state: kit.forms.questionnaire ? (missing ? `${missing} required answer${missing === 1 ? "" : "s"} missing` : "Complete") : "Not started", tone: kit.forms.questionnaire ? (missing ? "amber" : "green") : "gray" },
    { label: "Dispatch worksheet", state: kit.forms.dispatch_worksheet ? "In progress" : "Not started", tone: kit.forms.dispatch_worksheet ? "blue" : "gray" },
    { label: "Integrations", state: kit.forms.integration_checks ? "Being verified" : "Not started", tone: kit.forms.integration_checks ? "blue" : "gray" },
    { label: "Testing", state: kit.forms.testing ? `${issuesOpen} open issue${issuesOpen === 1 ? "" : "s"}` : "Not started", tone: issuesOpen ? "amber" : kit.forms.testing ? "green" : "gray" },
    { label: "Go-live acceptance", state: kit.accepted ? "Signed by both" : blockers.length ? `${blockers.length} item${blockers.length === 1 ? "" : "s"} to finish` : "Ready to sign", tone: kit.accepted ? "green" : blockers.length ? "amber" : "blue" },
  ];
  return (
    <Card>
      <CardHeader title="Your path to go-live" description="Setup, training and testing happen before go-live. Your subscription starts at your actual go-live, per your signed agreement — not when onboarding starts or data is imported." />
      <CardBody className="space-y-4">
        <ol className="divide-y divide-line rounded-md border border-line">
          {steps.map((s, i) => (
            <li key={s.label} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span className="font-semibold text-ink">{i + 1}. {s.label}</span>
              <Badge tone={s.tone}>{s.state}</Badge>
            </li>
          ))}
        </ol>
        <p className="text-sm text-muted">
          Tasks, owners, due dates and files are in the <a href={checklistHref} className="font-semibold text-brand-fg hover:underline">onboarding checklist</a>.
          {kit.lifecycle ? ` Stage: ${kit.lifecycle.stage.replace(/_/g, " ")}${kit.lifecycle.go_live_on ? `, go-live planned ${kit.lifecycle.go_live_on}` : ""}.` : ""}
        </p>
        {kit.gated && !kit.accepted ? (
          <Notice title="Going live needs the signed acceptance">
            {staff ? "Go Live Now and the scheduled go-live day both wait until the company owner and Taviron have signed the current acceptance." : "Your company goes live only after your owner and Taviron sign the go-live acceptance."}
          </Notice>
        ) : null}
      </CardBody>
    </Card>
  );
}

function WelcomeEmail({ f, staff, values }: { f: ReturnType<typeof useForm>; staff: boolean; values: WelcomeValues }) {
  const subject = (f.data.subject as string | undefined) ?? DEFAULT_WELCOME_SUBJECT;
  const body = (f.data.body as string | undefined) ?? DEFAULT_WELCOME_BODY;
  const kickoff = (f.data.kickoff as string | undefined) ?? "";
  const vals = { ...values, kickoff: kickoff || undefined, onboarding_contact: (f.data.onboarding_contact as string | undefined) || values.onboarding_contact,
    support_contact: (f.data.support_contact as string | undefined) || values.support_contact };
  const rendered = `Subject: ${renderWelcome(subject, vals)}\n\n${renderWelcome(body, vals)}`;
  const [copied, setCopied] = useState(false);
  return (
    <Card>
      <CardHeader title="Welcome email" description="A draft to send from your own email. Taviron does not send it: copy it, check it, and send it yourself." />
      <CardBody className="space-y-4">
        {staff ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Onboarding contact" htmlFor="we_contact"><Input id="we_contact" value={(f.data.onboarding_contact as string) ?? ""} onChange={(e) => f.set("onboarding_contact", e.target.value)} placeholder={values.onboarding_contact} /></Field>
            <Field label="Support contact (how to reach Taviron)" htmlFor="we_support"><Input id="we_support" value={(f.data.support_contact as string) ?? ""} onChange={(e) => f.set("support_contact", e.target.value)} placeholder={values.support_contact} /></Field>
            <Field label="Kickoff (date and how to join)" htmlFor="we_kickoff"><Input id="we_kickoff" value={kickoff} onChange={(e) => f.set("kickoff", e.target.value)} placeholder="Tuesday, November 4 at 9:00 (video call)" /></Field>
            <Field label="Subject" htmlFor="we_subject" className="sm:col-span-2"><Input id="we_subject" value={subject} onChange={(e) => f.set("subject", e.target.value)} /></Field>
            <Field label="Message" htmlFor="we_body" className="sm:col-span-2" hint="Placeholders: {{company_name}}, {{primary_contact}}, {{onboarding_contact}}, {{kickoff}}, {{support_contact}}.">
              <Textarea id="we_body" rows={16} value={body} onChange={(e) => f.set("body", e.target.value)} />
            </Field>
          </div>
        ) : null}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-ink">Preview</h3>
          <pre className="max-h-[28rem] overflow-auto rounded-md border border-line bg-surface p-4 text-sm whitespace-pre-wrap text-ink">{rendered}</pre>
          <p className="mt-2 text-xs text-muted">Anything in [brackets] still needs a value.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} onClick={async () => {
            try { await navigator.clipboard.writeText(rendered); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { toast.error("Copying is blocked in this browser. Select the preview text instead."); }
          }}>{copied ? "Copied" : "Copy Email"}</Button>
        </div>
        {staff ? <SaveBar f={f} /> : null}
      </CardBody>
    </Card>
  );
}

function Questionnaire({ f, missing }: { f: ReturnType<typeof useForm>; missing: string[] }) {
  return (
    <div className="space-y-5">
      <Notice title="Never include passwords or personal ID numbers">Names, roles and how you work are enough. Required answers are marked with *; you can save at any time and come back.</Notice>
      {QUESTIONNAIRE.map((s) => (
        <Card key={s.key}>
          <CardHeader title={s.title} description={s.description} />
          <CardBody>
            <div className="grid gap-4 sm:grid-cols-2">
              {s.fields.map((field) => {
                const id = `q_${field.key}`;
                const v = (f.data[field.key] as string | number | undefined) ?? "";
                return (
                  <Field key={field.key} label={field.label} htmlFor={id} required={field.required} hint={field.hint} className={field.kind === "textarea" ? "sm:col-span-2" : undefined}>
                    {field.kind === "textarea" ? <Textarea id={id} rows={3} value={String(v)} maxLength={2000} onChange={(e) => f.set(field.key, e.target.value)} />
                      : field.kind === "choice" ? (
                        <Select id={id} value={String(v)} onChange={(e) => f.set(field.key, e.target.value)}>
                          <option value="">Choose…</option>
                          {field.choices?.map((c) => <option key={c}>{c}</option>)}
                        </Select>
                      ) : <Input id={id} type={field.kind === "number" ? "number" : "text"} min={field.kind === "number" ? 0 : undefined} value={String(v)} maxLength={300}
                          onChange={(e) => f.set(field.key, field.kind === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />}
                  </Field>
                );
              })}
            </div>
          </CardBody>
        </Card>
      ))}
      <Card>
        <CardBody>
          {missing.length ? <p className="mb-3 text-sm text-ink">Still needed: {missing.join(", ")}.</p> : <p className="mb-3 text-sm text-ink">Every required answer is filled in.</p>}
          <SaveBar f={f} label="Save Answers" />
        </CardBody>
      </Card>
    </div>
  );
}

function DataImport({ templatesBase, checklistHref }: { templatesBase: string; checklistHref: string }) {
  const files = [
    { key: "customers", label: "Customers" },
    { key: "trucks", label: "Trucks" },
    { key: "drivers", label: "Drivers" },
    { key: "materials", label: "Materials" },
  ];
  return (
    <Card>
      <CardHeader title="Prepare and import your data" description="Download a template, fill it from your current system, and upload it to the matching task in the onboarding checklist." />
      <CardBody className="space-y-4">
        <ul className="grid gap-2 sm:grid-cols-2">
          {files.map((t) => (
            <li key={t.key}>
              <a href={`${templatesBase}/${t.key}`} download className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 py-2 text-sm font-semibold text-ink hover:bg-surface">
                <Download className="size-4" aria-hidden /> {t.label} template (CSV)
              </a>
            </li>
          ))}
        </ul>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-ink">
          <li>Keep the first row (the column names). Columns marked “(required)” must be filled for every row.</li>
          <li>Upload the file to its task in the <a href={checklistHref} className="font-semibold text-brand-fg hover:underline">onboarding checklist</a>.</li>
          <li>Taviron loads it into the importer: every row is checked; possible duplicates and errors are listed by row.</li>
          <li>Nothing is created until the batch is approved, and you confirm the counts before go-live (acceptance item “Data import validated”).</li>
        </ol>
        <Notice title="Locations">Dispatch bases are set up in Settings → Dispatch Bases (your plan decides how many); they are not imported from a file.</Notice>
      </CardBody>
    </Card>
  );
}

type Scenario = { rule: string; scenario: string; expected: string; result: "not_run" | "pass" | "fail"; notes: string };

function Worksheet({ f }: { f: ReturnType<typeof useForm> }) {
  const notes = (f.data.notes as Record<string, string> | undefined) ?? {};
  const scenarios = (f.data.scenarios as Scenario[] | undefined) ?? [];
  const setScenarios = (s: Scenario[]) => f.set("scenarios", s);
  return (
    <div className="space-y-5">
      <Notice title="What each label means">
        <strong>Product-enforced</strong>: Taviron applies it automatically. <strong>Manually checked</strong>: people check it; Taviron does not. <strong>Unsupported</strong>: Taviron does not cover it. <strong>Not yet tested</strong>: no passing test scenario recorded for your company yet.
      </Notice>
      {DISPATCH_RULES.map((r) => {
        const passed = scenarios.some((s) => s.rule === r.key && s.result === "pass");
        return (
          <Card key={r.key}>
            <CardHeader title={r.title} actions={<span className="flex flex-wrap gap-1"><Badge tone={ENFORCEMENT_TONE[r.product]}>{ENFORCEMENT_LABEL[r.product]}</Badge>{!passed ? <Badge tone="blue">{ENFORCEMENT_LABEL.untested}</Badge> : <Badge tone="green">Tested</Badge>}</span>} />
            <CardBody className="space-y-3">
              <p className="text-sm text-muted">{r.evidence}{r.settingsHref ? <> <a href={r.settingsHref} className="font-semibold text-brand-fg hover:underline">Open the setting</a></> : null}</p>
              <Field label="Your rule and how you handle it" htmlFor={`w_${r.key}`}>
                <Textarea id={`w_${r.key}`} rows={2} maxLength={2000} value={notes[r.key] ?? ""} onChange={(e) => f.set("notes", { ...notes, [r.key]: e.target.value })} />
              </Field>
            </CardBody>
          </Card>
        );
      })}
      <Card>
        <CardHeader title="Test scenarios" description="Representative situations with the result you expect. Record the actual result after running them in Taviron." actions={
          <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => setScenarios([...scenarios, { rule: DISPATCH_RULES[0].key, scenario: "", expected: "", result: "not_run", notes: "" }])}>Add Scenario</Button>
        } />
        <CardBody className="space-y-4">
          {scenarios.length === 0 ? <p className="text-sm text-muted">No scenarios yet. Example: “Truck 12 is out of service → it is not proposed for tomorrow&apos;s loads.”</p> : null}
          {scenarios.map((s, i) => (
            <fieldset key={i} className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs font-semibold text-muted">Scenario {i + 1}</legend>
              <Field label="Rule" htmlFor={`s_rule_${i}`}>
                <Select id={`s_rule_${i}`} value={s.rule} onChange={(e) => setScenarios(scenarios.map((x, j) => (j === i ? { ...x, rule: e.target.value } : x)))}>
                  {DISPATCH_RULES.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
                </Select>
              </Field>
              <Field label="Result" htmlFor={`s_res_${i}`}>
                <Select id={`s_res_${i}`} value={s.result} onChange={(e) => setScenarios(scenarios.map((x, j) => (j === i ? { ...x, result: e.target.value as Scenario["result"] } : x)))}>
                  <option value="not_run">Not run yet</option><option value="pass">Passed</option><option value="fail">Failed</option>
                </Select>
              </Field>
              <Field label="Situation" htmlFor={`s_sc_${i}`}><Input id={`s_sc_${i}`} value={s.scenario} maxLength={300} onChange={(e) => setScenarios(scenarios.map((x, j) => (j === i ? { ...x, scenario: e.target.value } : x)))} /></Field>
              <Field label="Expected result" htmlFor={`s_ex_${i}`}><Input id={`s_ex_${i}`} value={s.expected} maxLength={300} onChange={(e) => setScenarios(scenarios.map((x, j) => (j === i ? { ...x, expected: e.target.value } : x)))} /></Field>
              <Field label="What happened (evidence)" htmlFor={`s_no_${i}`} className="sm:col-span-2"><Input id={`s_no_${i}`} value={s.notes} maxLength={500} onChange={(e) => setScenarios(scenarios.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))} /></Field>
              <div className="sm:col-span-2"><Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setScenarios(scenarios.filter((_, j) => j !== i))}>Remove</Button></div>
            </fieldset>
          ))}
          <SaveBar f={f} label="Save Worksheet" />
        </CardBody>
      </Card>
    </div>
  );
}

function Integrations({ f, checks, staff, config }: { f: ReturnType<typeof useForm>; checks: ReturnType<typeof useForm>; staff: boolean; config?: Record<string, boolean> }) {
  const plan = (f.data.items as Record<string, { needed?: string; business_owner?: string; technical_owner?: string; data_flow?: string; blockers?: string }> | undefined) ?? {};
  const results = (checks.data.items as Record<string, { status?: CheckStatus; verified_at?: string; evidence?: string }> | undefined) ?? {};
  const setPlan = (k: string, v: Record<string, string>) => f.set("items", { ...plan, [k]: { ...plan[k], ...v } });
  const setCheck = (k: string, v: Record<string, string>) => checks.set("items", { ...results, [k]: { ...results[k], ...v } });
  return (
    <div className="space-y-5">
      <Notice title="No passwords or keys here">Connections are configured by Taviron on the server. This checklist records who owns each one, how it is verified, and the fallback.</Notice>
      {INTEGRATIONS.map((d) => {
        const p = plan[d.key] ?? {};
        const r = results[d.key] ?? {};
        const status: CheckStatus = r.status ?? (d.available ? "not_started" : "unavailable");
        return (
          <Card key={d.key}>
            <CardHeader title={d.name} description={`${d.purpose}. System of record: ${d.systemOfRecord}.`} actions={
              <span className="flex flex-wrap gap-1">
                {!d.available ? <Badge tone="gray">Not available in Taviron</Badge> : null}
                {staff && d.configKey ? <Badge tone={config?.[d.configKey] ? "green" : "gray"}>{config?.[d.configKey] ? "Configured on server" : "Not configured"}</Badge> : null}
                <Badge tone={status === "verified" ? "green" : status === "failed" ? "critical-soft" : "gray"}>{CHECK_STATUS_LABEL[status]}</Badge>
              </span>
            } />
            <CardBody className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Needed?" htmlFor={`i_need_${d.key}`}>
                  <Select id={`i_need_${d.key}`} value={p.needed ?? ""} onChange={(e) => setPlan(d.key, { needed: e.target.value })}>
                    <option value="">Not decided</option><option>Required</option><option>Nice to have</option><option>Not needed</option>
                  </Select>
                </Field>
                <Field label="Data flow" htmlFor={`i_flow_${d.key}`}><Input id={`i_flow_${d.key}`} value={p.data_flow ?? ""} maxLength={300} onChange={(e) => setPlan(d.key, { data_flow: e.target.value })} /></Field>
                <Field label="Business owner" htmlFor={`i_bo_${d.key}`}><Input id={`i_bo_${d.key}`} value={p.business_owner ?? ""} maxLength={120} onChange={(e) => setPlan(d.key, { business_owner: e.target.value })} /></Field>
                <Field label="Technical owner" htmlFor={`i_to_${d.key}`}><Input id={`i_to_${d.key}`} value={p.technical_owner ?? ""} maxLength={120} onChange={(e) => setPlan(d.key, { technical_owner: e.target.value })} /></Field>
                <Field label="Outstanding blockers" htmlFor={`i_bl_${d.key}`} className="sm:col-span-2"><Input id={`i_bl_${d.key}`} value={p.blockers ?? ""} maxLength={500} onChange={(e) => setPlan(d.key, { blockers: e.target.value })} /></Field>
              </div>
              <p className="text-sm text-muted">If it fails: {d.fallback}</p>
              {staff ? (
                <div className="grid gap-3 rounded-md bg-surface p-3 sm:grid-cols-3">
                  <Field label="Verification" htmlFor={`c_st_${d.key}`}>
                    <Select id={`c_st_${d.key}`} value={status} onChange={(e) => setCheck(d.key, { status: e.target.value, ...(e.target.value === "verified" ? { verified_at: new Date().toISOString() } : {}) })}>
                      {(Object.keys(CHECK_STATUS_LABEL) as CheckStatus[]).filter((s) => d.available ? s !== "unavailable" : ["unavailable", "not_needed", "not_started"].includes(s))
                        .map((s) => <option key={s} value={s} disabled={s === "verified" && Boolean(d.configKey) && !config?.[d.configKey!]}>{CHECK_STATUS_LABEL[s]}</option>)}
                    </Select>
                  </Field>
                  <Field label="Evidence" htmlFor={`c_ev_${d.key}`} className="sm:col-span-2"><Input id={`c_ev_${d.key}`} value={r.evidence ?? ""} maxLength={500} placeholder="What was tested and the result" onChange={(e) => setCheck(d.key, { evidence: e.target.value })} /></Field>
                </div>
              ) : r.verified_at ? <p className="text-xs text-muted">Last verified {formatDateTime(r.verified_at)}{r.evidence ? `: ${r.evidence}` : ""}</p> : null}
            </CardBody>
          </Card>
        );
      })}
      <Card><CardBody className="space-y-4"><SaveBar f={f} label="Save Owners and Notes" />{staff ? <SaveBar f={checks} label="Save Verification" /> : null}</CardBody></Card>
    </div>
  );
}

type Issue = { title: string; severity: "low" | "medium" | "high"; critical: boolean; status: "open" | "resolved"; owner: string; notes: string };

function Testing({ f }: { f: ReturnType<typeof useForm> }) {
  const issues = (f.data.issues as Issue[] | undefined) ?? [];
  const set = (list: Issue[]) => f.set("issues", list);
  return (
    <Card>
      <CardHeader title="Testing and issues" description="Everything found while trying Taviron with your team. A critical issue (security, data, dispatch or safety) blocks go-live until it is resolved." actions={
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} onClick={() => set([...issues, { title: "", severity: "medium", critical: false, status: "open", owner: "", notes: "" }])}>Add Issue</Button>
      } />
      <CardBody className="space-y-4">
        {issues.length === 0 ? <p className="text-sm text-muted">No issues recorded.</p> : null}
        {issues.map((x, i) => (
          <fieldset key={i} className={cn("grid gap-3 rounded-md border p-3 sm:grid-cols-4", x.critical && x.status !== "resolved" ? "border-critical" : "border-line")}>
            <legend className="px-1 text-xs font-semibold text-muted">Issue {i + 1}{x.critical && x.status !== "resolved" ? " — blocks go-live" : ""}</legend>
            <Field label="What happened" htmlFor={`t_ti_${i}`} className="sm:col-span-2"><Input id={`t_ti_${i}`} value={x.title} maxLength={200} onChange={(e) => set(issues.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))} /></Field>
            <Field label="Owner" htmlFor={`t_ow_${i}`}><Input id={`t_ow_${i}`} value={x.owner} maxLength={120} onChange={(e) => set(issues.map((y, j) => (j === i ? { ...y, owner: e.target.value } : y)))} /></Field>
            <Field label="Status" htmlFor={`t_st_${i}`}>
              <Select id={`t_st_${i}`} value={x.status} onChange={(e) => set(issues.map((y, j) => (j === i ? { ...y, status: e.target.value as Issue["status"] } : y)))}><option value="open">Open</option><option value="resolved">Resolved</option></Select>
            </Field>
            <Field label="Severity" htmlFor={`t_sv_${i}`}>
              <Select id={`t_sv_${i}`} value={x.severity} onChange={(e) => set(issues.map((y, j) => (j === i ? { ...y, severity: e.target.value as Issue["severity"] } : y)))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select>
            </Field>
            <div className="flex items-end pb-2 sm:col-span-3"><Checkbox label="Critical (security, data integrity, dispatch or safety)" checked={x.critical} onChange={(e) => set(issues.map((y, j) => (j === i ? { ...y, critical: e.currentTarget.checked } : y)))} /></div>
            <Field label="Notes and resolution" htmlFor={`t_no_${i}`} className="sm:col-span-4"><Input id={`t_no_${i}`} value={x.notes} maxLength={1000} onChange={(e) => set(issues.map((y, j) => (j === i ? { ...y, notes: e.target.value } : y)))} /></Field>
          </fieldset>
        ))}
        <SaveBar f={f} label="Save Issues" />
      </CardBody>
    </Card>
  );
}

function GoLive({ f, kit, staff, blockers, canSign, sign }: { f: ReturnType<typeof useForm>; kit: KitState; staff: boolean; blockers: string[]; canSign: boolean; sign: SignFn }) {
  const router = useRouter();
  const items = (f.data.items as Record<string, { status?: GoLiveStatus; note?: string }> | undefined) ?? {};
  const setItem = (k: string, v: { status?: GoLiveStatus; note?: string }) => f.set("items", { ...items, [k]: { ...items[k], ...v } });
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = kit.signoffs.filter((s) => s.current);
  const party = staff ? "taviron" : "company";
  const signedHere = current.some((s) => s.party === party);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Go-live acceptance" description="Taviron records each result with its evidence. Critical items must pass; they cannot be waived. Any change after a sign-off voids that sign-off." />
        <CardBody>
          <ul className="divide-y divide-line">
            {GO_LIVE_ITEMS.map((i) => {
              const it = items[i.key] ?? {};
              const s: GoLiveStatus = it.status ?? "not_started";
              return (
                <li key={i.key} className="grid gap-3 py-3 sm:grid-cols-[1fr_12rem]">
                  <div>
                    <p className="text-sm font-semibold text-ink">{i.title} {i.critical ? <Badge tone="critical-soft" className="ml-1">Critical</Badge> : null}</p>
                    <p className="text-xs text-muted">{i.evidenceHint}</p>
                    {staff ? (
                      <Input aria-label={`Evidence or reason: ${i.title}`} className="mt-2" value={it.note ?? ""} maxLength={500} placeholder="Evidence, or the reason for an exception" onChange={(e) => setItem(i.key, { note: e.target.value })} />
                    ) : it.note ? <p className="mt-1 text-sm text-ink">{it.note}</p> : null}
                  </div>
                  {staff ? (
                    <Select aria-label={`Result: ${i.title}`} value={s} onChange={(e) => setItem(i.key, { status: e.target.value as GoLiveStatus })}>
                      {(Object.keys(GO_LIVE_STATUS_LABEL) as GoLiveStatus[]).filter((x) => !(i.critical && (x === "not_applicable" || x === "exception"))).map((x) => <option key={x} value={x}>{GO_LIVE_STATUS_LABEL[x]}</option>)}
                    </Select>
                  ) : <span className="self-start"><Badge tone={GO_TONE[s]}>{GO_LIVE_STATUS_LABEL[s]}</Badge></span>}
                </li>
              );
            })}
          </ul>
          {staff ? <SaveBar f={f} label="Save Acceptance" /> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Sign-off" description="A recorded confirmation with your typed name, not a digital signature. Both the company owner and Taviron sign the same version." />
        <CardBody className="space-y-4">
          {blockers.length ? (
            <div role="status" className="rounded-md border border-line bg-surface p-3 text-sm">
              <p className="font-semibold text-ink">Not ready to sign:</p>
              <ul className="mt-1 list-disc pl-5 text-ink">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            </div>
          ) : null}
          <ul className="space-y-1 text-sm">
            {kit.signoffs.length === 0 ? <li className="text-muted">No sign-offs yet.</li> : kit.signoffs.map((s) => (
              <li key={s.id} className={s.current ? "text-ink" : "text-muted line-through"}>
                {s.party === "company" ? "Company" : "Taviron"}: {s.signer_name}{s.signer_title ? `, ${s.signer_title}` : ""} · {formatDateTime(s.signed_at)} · version {s.go_live_version}{s.current ? "" : " (voided by a later change)"}
              </li>
            ))}
          </ul>
          {kit.accepted ? <Notice title="Accepted by both">Go-live can now be activated on the agreed day.</Notice> : null}
          {!canSign ? (
            <p className="text-sm text-muted">Only an owner of the company signs the acceptance.</p>
          ) : signedHere ? (
            <p className="text-sm text-ink">You have signed the current version.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Your full name" htmlFor="sign_name" required><Input id="sign_name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Title" htmlFor="sign_title"><Input id="sign_title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
              <div className="sm:col-span-2">
                <Checkbox label={staff ? "I verified the evidence for every item and agree the company is ready to go live." : "I reviewed the acceptance, its evidence and any exceptions, and accept going live on these terms."}
                  checked={confirmed} onChange={(e) => setConfirmed(e.currentTarget.checked)} />
              </div>
              <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
                <Button disabled={!confirmed || name.trim().length < 2 || blockers.length > 0 || f.dirty || !kit.forms.go_live} loading={busy} onClick={async () => {
                  setBusy(true); setError(null);
                  const r = await sign({ name, title, version: kit.forms.go_live?.version ?? 0, confirm: true });
                  setBusy(false);
                  if (!r.ok) return setError(r.error);
                  toast.success(r.message ?? "Signed.");
                  router.refresh();
                }}>Sign Go-Live Acceptance</Button>
                {f.dirty ? <span className="text-xs text-muted">Save the acceptance first.</span> : null}
                <FormError message={error} />
              </div>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

type FollowUp = { title: string; done: boolean; notes: string };
const DEFAULT_FOLLOW_UPS: FollowUp[] = [
  { title: "First-week check-in: dispatch, tickets and billing hand-off", done: false, notes: "" },
  { title: "30-day review: open issues, training gaps, reports", done: false, notes: "" },
  { title: "Manual controls still in place (reviewed and owned)", done: false, notes: "" },
];

function After({ f, live }: { f: ReturnType<typeof useForm>; live: boolean }) {
  const list = (f.data.follow_ups as FollowUp[] | undefined) ?? DEFAULT_FOLLOW_UPS;
  const set = (l: FollowUp[]) => f.set("follow_ups", l);
  return (
    <Card>
      <CardHeader title="After launch" description={live ? "Follow-ups after going live." : "These follow-ups start once the company is live."} />
      <CardBody className="space-y-3">
        {list.map((x, i) => (
          <div key={i} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-[1fr_16rem]">
            <Checkbox label={x.title} checked={x.done} onChange={(e) => set(list.map((y, j) => (j === i ? { ...y, done: e.currentTarget.checked } : y)))} />
            <Input aria-label={`Notes: ${x.title}`} value={x.notes} maxLength={500} placeholder="Notes" onChange={(e) => set(list.map((y, j) => (j === i ? { ...y, notes: e.target.value } : y)))} />
          </div>
        ))}
        <SaveBar f={f} label="Save Follow-ups" />
      </CardBody>
    </Card>
  );
}
