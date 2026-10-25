import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState, Notice } from "@/components/ui/states";
import { cn } from "@/lib/cn";
import { can, type Access } from "@/lib/permissions";
import { formatDay, formatQuantity, REQUEST_STATUS_LABEL, SUPPORT_STATUS_LABEL } from "@/lib/portal";
import { isUsernameEmail } from "@/lib/usernames";
import { requirePagePermission } from "@/server/auth";
import { accountStates, emailServerStatus } from "@/server/accounts";
import { PortalSignInForm } from "@/components/accounts/portal-sign-in-form";
import { SignInManager } from "@/components/accounts/sign-in-manager";
import { createClient } from "@/server/supabase/server";
import {
  HelpArticleForm, InviteForm, PortalSettingsForm, QuoteRequestForm, QuoteResponseButtons, RevokeAccountButton, StaffReplyForm, type PortalSettingsValues,
} from "@/components/portal/staff-portal-forms";

export const metadata = { title: "Customer Portal" };

const TABS = [
  { key: "inbox", label: "Requests" },
  { key: "access", label: "Customer Access" },
  { key: "help", label: "Help Articles" },
  { key: "settings", label: "Settings" },
] as const;

const DEFAULTS: PortalSettingsValues = {
  enabled: false, public_page: false, display_name: "", welcome: "", contact_email: "", contact_phone: "", hours: "",
  feature_orders: true, feature_quotes: true, feature_documents: true, feature_support: true, feature_help: true, feature_tracking: false,
};

type State = { entitled: boolean; open: boolean; slug: string; settings: (PortalSettingsValues & { updated_at: string }) | null };
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * The company's side of its customer portal (B66): customer requests to answer, who has access, help articles and the
 * portal's settings. Everything a customer sends lands here; nothing is answered or confirmed automatically.
 */
export default async function CustomerPortalPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const access = await requirePagePermission("customers.view");
  const { tab: raw } = await searchParams;
  const tab = TABS.find((t) => t.key === raw)?.key ?? "inbox";
  const supabase = await createClient();
  const { data: stateData, error } = await supabase.rpc("portal_admin_state");
  if (error) {
    return (
      <>
        <PageHeader title="Customer Portal" />
        <ErrorState title="The customer portal needs a database update" description="Apply migration 20261120000700 (owner step, docs/runbooks/2026-10-14-hosted-db.md §13). Nothing else changes until then." />
      </>
    );
  }
  const state = stateData as State;
  const settings = { ...DEFAULTS, ...(state.settings ?? {}) };
  const portalUrl = `/portal/${state.slug}`;

  let content: React.ReactNode = null;
  if (tab === "inbox") content = await Inbox(access.permissions.includes("quotes.view"), can(access, "customers.edit"), can(access, "quotes.edit"), can(access, "quotes.status"));
  else if (tab === "access") content = await AccessTab(access, can(access, "customers.edit"), state.open);
  else if (tab === "help") content = await HelpTab(can(access, "settings.manage"));
  else
    content = (
      <Card>
        <CardHeader title="Portal Settings" description="Your portal uses your company name, logo and colour from Company settings." />
        <CardBody>
          <PortalSettingsForm values={settings} entitled={state.entitled} canEdit={can(access, "settings.manage")} />
        </CardBody>
      </Card>
    );

  return (
    <>
      <PageHeader
        title="Customer Portal"
        description="Your customers follow their orders, deliveries and quotes, request quotes and ask questions."
        badges={<Badge tone={state.open ? "green" : "gray"}>{state.open ? "Open" : "Off"}</Badge>}
        actions={state.open ? <Link href={portalUrl} target="_blank" className="text-sm font-semibold text-brand-fg hover:underline">Open the portal</Link> : null}
      />
      {!state.entitled ? (
        <div className="mb-4">
          <Notice title="Not included in your plan yet">The customer portal is turned on by Taviron for your company. You can prepare help articles and settings now; customers cannot sign in until it is on.</Notice>
        </div>
      ) : !settings.enabled ? (
        <div className="mb-4">
          <Notice title="The portal is off">Turn it on in Settings when you are ready. Invitations can be created now.</Notice>
        </div>
      ) : null}
      <nav aria-label="Customer portal sections" className="mb-4 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <Link key={t.key} href={`/customer-portal?tab=${t.key}`} aria-current={tab === t.key ? "page" : undefined} className={cn("rounded-xl px-3 py-1.5 text-sm font-semibold", tab === t.key ? "bg-strong text-white" : "text-muted hover:bg-surface hover:text-ink")}>
            {t.label}
          </Link>
        ))}
      </nav>
      {content}
    </>
  );
}

async function Inbox(canSeeQuotes: boolean, canReply: boolean, canEditQuotes: boolean, canDecide: boolean) {
  const supabase = await createClient();
  const [support, messages, requests, responses, customers] = await Promise.all([
    supabase.from("portal_support_requests").select("id, customer_id, subject, status, created_at, updated_at, order_id").order("updated_at", { ascending: false }).limit(50),
    supabase.from("portal_messages").select("request_id, author_kind, body, created_at").order("created_at").limit(500),
    canSeeQuotes ? supabase.from("portal_quote_requests").select("id, customer_id, material, quantity, unit, requested_date, site_text, notes, status, quote_id, created_at").order("created_at", { ascending: false }).limit(50) : Promise.resolve({ data: [] }),
    canSeeQuotes ? supabase.from("portal_quote_responses").select("id, quote_id, response, signer_name, note, status, created_at").eq("status", "pending").order("created_at") : Promise.resolve({ data: [] }),
    supabase.from("customers").select("id, name"),
  ]);
  const names = new Map(((customers.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]));
  const threads = (support.data ?? []) as Array<{ id: string; customer_id: string; subject: string; status: "open" | "answered" | "closed"; created_at: string; updated_at: string }>;
  const msgs = (messages.data ?? []) as Array<{ request_id: string; author_kind: string; body: string; created_at: string }>;
  const reqs = (requests.data ?? []) as Array<{ id: string; customer_id: string; material: string; quantity: number | null; unit: string; requested_date: string | null; site_text: string; notes: string; status: keyof typeof REQUEST_STATUS_LABEL; quote_id: string | null; created_at: string }>;
  const resp = (responses.data ?? []) as Array<{ id: string; quote_id: string; response: "accept" | "decline"; signer_name: string; note: string; created_at: string }>;
  const quoteIds = [...new Set(resp.map((r) => r.quote_id))];
  const { data: quoteRows } = quoteIds.length ? await supabase.from("quotes").select("id, quote_number, customer_id").in("id", quoteIds) : { data: [] };
  const quotes = new Map(((quoteRows ?? []) as Array<{ id: string; quote_number: string; customer_id: string }>).map((q) => [q.id, q]));
  const customerQuotes = async (customer: string) => {
    const { data } = await supabase.from("quotes").select("id, quote_number").eq("customer_id", customer).neq("status", "draft").order("created_at", { ascending: false }).limit(20);
    return ((data ?? []) as Array<{ id: string; quote_number: string }>).map((q) => ({ id: q.id, number: q.quote_number }));
  };
  const openReqs = reqs.filter((r) => r.status === "new" || r.status === "reviewing");
  const quoteChoices = new Map<string, Array<{ id: string; number: string }>>();
  for (const c of new Set(openReqs.map((r) => r.customer_id))) quoteChoices.set(c, await customerQuotes(c));

  if (!threads.length && !reqs.length && !resp.length) {
    return <EmptyState title="No customer requests yet" description="Support requests, quote requests and quote answers from your customers appear here." />;
  }
  return (
    <div className="space-y-5">
      {resp.length ? (
        <Card>
          <CardHeader title="Quote Answers to Confirm" description="A customer's answer changes nothing until you confirm it. Confirming an acceptance runs your normal quote workflow." />
          <CardBody>
            <ul className="divide-y divide-line">
              {resp.map((r) => {
                const q = quotes.get(r.quote_id);
                return (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                    <span>
                      <span className="block font-semibold text-ink">
                        {r.response === "accept" ? "Accepted" : "Declined"} quote <Link href={`/quotes/${r.quote_id}`} className="hover:underline">{q?.quote_number ?? "—"}</Link> · {names.get(q?.customer_id ?? "") ?? ""}
                      </span>
                      <span className="block text-muted">{r.signer_name} · {WHEN.format(new Date(r.created_at))}{r.note ? ` · “${r.note}”` : ""}</span>
                    </span>
                    {canDecide ? <QuoteResponseButtons response={r.id} accept={r.response === "accept"} /> : null}
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {reqs.length ? (
        <Card>
          <CardHeader title="Quote Requests" description="Price them in Quotes as usual, then link the quote here so the customer sees it." />
          <CardBody>
            <ul className="divide-y divide-line">
              {reqs.map((r) => (
                <li key={r.id} className="space-y-2 py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span>
                      <span className="block font-semibold text-ink">{names.get(r.customer_id) ?? "Customer"} · {r.material}{r.quantity ? ` · ${formatQuantity(r.quantity, r.unit)}` : ""}</span>
                      <span className="block text-muted">{[r.requested_date ? `Needed ${formatDay(r.requested_date)}` : "", r.site_text, `Sent ${formatDay(r.created_at)}`].filter(Boolean).join(" · ")}</span>
                      {r.notes ? <span className="block whitespace-pre-line text-ink">{r.notes}</span> : null}
                    </span>
                    <Badge tone={r.status === "new" ? "brand" : r.status === "quoted" ? "green" : "gray"}>{REQUEST_STATUS_LABEL[r.status]}</Badge>
                  </div>
                  {canEditQuotes && (r.status === "new" || r.status === "reviewing") ? (
                    <div className="flex flex-wrap items-end gap-3">
                      <QuoteRequestForm request={r.id} status={r.status} quotes={quoteChoices.get(r.customer_id) ?? []} />
                      <Link href={`/quotes/new?customer=${r.customer_id}`} className="pb-2 text-sm font-semibold text-brand-fg hover:underline">New quote for this customer</Link>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {threads.length ? (
        <Card>
          <CardHeader title="Support Requests" />
          <CardBody>
            <ul className="divide-y divide-line">
              {threads.map((t) => (
                <li key={t.id} className="space-y-2 py-3">
                  <details open={t.status === "open"}>
                    <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="font-semibold text-ink">{names.get(t.customer_id) ?? "Customer"} · {t.subject}</span>
                      <Badge tone={t.status === "open" ? "brand" : t.status === "answered" ? "green" : "gray"}>{t.status === "open" ? "Needs a reply" : SUPPORT_STATUS_LABEL[t.status]}</Badge>
                    </summary>
                    <ol className="mt-3 space-y-2">
                      {msgs.filter((m) => m.request_id === t.id).map((m, i) => (
                        <li key={i} className={cn("rounded-xl border p-2 text-sm", m.author_kind === "customer" ? "border-line bg-card" : "border-brand/30 bg-brand-light")}>
                          <p className="text-xs font-semibold text-muted">{m.author_kind === "customer" ? "Customer" : "Your team"} · {WHEN.format(new Date(m.created_at))}</p>
                          <p className="whitespace-pre-line text-ink">{m.body}</p>
                        </li>
                      ))}
                    </ol>
                    {canReply && t.status !== "closed" ? <div className="mt-3"><StaffReplyForm request={t.id} /></div> : null}
                  </details>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

type PortalAccountRow = {
  id: string; customer_id: string; contact_id: string | null; user_id: string | null; email: string; status: string;
  invited_at: string; accepted_at: string | null; last_seen_at: string | null; invite_expires_at: string | null;
};

async function AccessTab(access: Access, canEdit: boolean, open: boolean) {
  const supabase = await createClient();
  const [accounts, customers, contacts, states] = await Promise.all([
    supabase.from("portal_accounts").select("id, customer_id, contact_id, user_id, email, status, invited_at, accepted_at, last_seen_at, invite_expires_at").order("invited_at", { ascending: false }),
    supabase.from("customers").select("id, name").eq("active", true).order("name"),
    supabase.from("customer_contacts").select("id, customer_id, name, email").eq("active", true).order("name"),
    canEdit ? accountStates("portal") : Promise.resolve(null),
  ]);
  const list = (customers.data ?? []) as Array<{ id: string; name: string }>;
  const names = new Map(list.map((c) => [c.id, c.name]));
  const contactRows = (contacts.data ?? []) as Array<{ id: string; customer_id: string; name: string; email: string }>;
  const contactName = new Map(contactRows.map((c) => [c.id, c]));
  const all = (accounts.data ?? []) as PortalAccountRow[];
  // Username sign-ins (made here, managed below) and email invitations (the earlier flow) are listed apart.
  const usernameRows = all.filter((a) => a.user_id && isUsernameEmail(a.email) && states?.has(a.user_id));
  const rows = all.filter((a) => a.status !== "revoked" && !usernameRows.includes(a));
  const taken = usernameRows.filter((a) => a.status !== "revoked" && a.contact_id).map((a) => a.contact_id!);
  const mail = emailServerStatus(Boolean(access.isDemo));
  const companyName = access.companyName ?? "Your company";
  return (
    <div className="space-y-5">
      {canEdit ? (
        <Card>
          <CardHeader title="Create a Customer Sign-in" description="A username and a temporary password for one person at one customer; no email needed. They choose their own password the first time." />
          <CardBody>
            {access.isDemo ? (
              <Notice title="Not in a demo company">Demo companies do not create sign-ins. Preview the portal as a customer from the Testing Lab instead.</Notice>
            ) : !open ? (
              <Notice title="Turn the portal on first">Customer sign-ins can be created once the portal is on (Settings tab).</Notice>
            ) : states === null ? (
              <Notice title="Needs a database update">Username sign-ins need the database update 20261120001200, which is not installed yet. Email invitations below still work.</Notice>
            ) : (
              <PortalSignInForm customers={list} contacts={contactRows} taken={taken} companyName={companyName} emailConfigured={mail.configured} emailReason={mail.reason} />
            )}
          </CardBody>
        </Card>
      ) : null}
      {usernameRows.length ? (
        <Card>
          <CardHeader title="Customer Sign-ins" description="Created here with a username. Turning one off keeps the customer's requests and history." />
          <CardBody>
            {(() => {
              const list = (rowsOf: PortalAccountRow[]) => (
                <ul className="divide-y divide-line">
                  {rowsOf.map((a) => {
                const st = states!.get(a.user_id!)!;
                const person = a.contact_id ? contactName.get(a.contact_id) : undefined;
                const to = person?.email && !isUsernameEmail(person.email) ? person.email : "";
                return (
                  <li key={a.id} className="space-y-2 py-3">
                    <p className="text-sm"><span className="font-semibold text-ink">{person?.name ?? "Contact"}</span> <span className="text-muted">· {names.get(a.customer_id) ?? "Customer"}</span></p>
                    <SignInManager
                      kind="portal"
                      s={{ userId: st.user_id, username: st.username, status: st.status, expired: st.expired, issuedAt: st.issued_at, expiresAt: st.expires_at, completedAt: st.completed_at, lastSignInAt: st.last_sign_in_at, banned: st.banned, active: a.status !== "revoked" }}
                      personName={person?.name ?? st.username}
                      companyName={companyName}
                      email={mail.configured && to ? { available: true, to } : { available: false, reason: mail.configured ? "Add the contact's email in Customers to send a setup link." : mail.reason }}
                    />
                  </li>
                );
              })}
                </ul>
              );
              const on = usernameRows.filter((a) => a.status !== "revoked");
              const off = usernameRows.filter((a) => a.status === "revoked");
              return (
                <>
                  {on.length ? list(on) : <p className="text-sm text-muted">No active customer sign-ins.</p>}
                  {off.length ? (
                    <details className="mt-3 border-t border-line pt-3">
                      <summary className="cursor-pointer text-sm font-semibold text-muted hover:text-ink">Turned off ({off.length})</summary>
                      {list(off)}
                    </details>
                  ) : null}
                </>
              );
            })()}
          </CardBody>
        </Card>
      ) : null}
      {canEdit ? (
        <Card>
          <CardHeader title="Invite a Customer Contact by Email" description="Each email belongs to one customer and sees only that customer's records. A portal account never gets access to your workspace." />
          <CardBody>
            <InviteForm customers={list} contacts={contactRows} />
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="Email Invitations" />
        <CardBody>
          {rows.length ? (
            <ul className="divide-y divide-line text-sm">
              {rows.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    <span className="block font-semibold text-ink">{a.email}</span>
                    <span className="block text-muted">
                      {names.get(a.customer_id) ?? "Customer"} ·{" "}
                      {a.status === "active" ? (a.last_seen_at ? `Last visit ${formatDay(a.last_seen_at)}` : `Joined ${formatDay(a.accepted_at)}`) : a.invite_expires_at && Date.parse(a.invite_expires_at) < Date.now() ? "Invitation expired" : `Invited ${formatDay(a.invited_at)}`}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge tone={a.status === "active" ? "green" : "gray"}>{a.status === "active" ? "Active" : "Invited"}</Badge>
                    {canEdit ? <RevokeAccountButton account={a.id} email={a.email} /> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{usernameRows.length ? "No email invitations." : "Nobody has portal access yet."}</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

async function HelpTab(canEdit: boolean) {
  const supabase = await createClient();
  const [{ data }, { data: votes }] = await Promise.all([
    supabase.from("portal_help_articles").select("id, title, category, body, status, published_at, updated_at").order("category").order("title"),
    canEdit ? supabase.from("portal_help_feedback").select("article_id, helpful") : Promise.resolve({ data: [] }),
  ]);
  const articles = (data ?? []) as Array<{ id: string; title: string; category: string; body: string; status: string; published_at: string | null }>;
  const tally = new Map<string, { yes: number; no: number }>();
  for (const v of (votes ?? []) as Array<{ article_id: string; helpful: boolean }>) {
    const t = tally.get(v.article_id) ?? { yes: 0, no: 0 };
    if (v.helpful) t.yes++;
    else t.no++;
    tally.set(v.article_id, t);
  }
  return (
    <div className="space-y-5">
      <Notice title="What customers see">Published articles appear in your portal&apos;s Help with general guidance on using the portal. Write only policies you have approved; nothing is published automatically.</Notice>
      {canEdit ? (
        <Card>
          <CardHeader title="New Article" />
          <CardBody>
            <HelpArticleForm />
          </CardBody>
        </Card>
      ) : null}
      {articles.length ? (
        articles.map((a) => (
          <Card key={a.id}>
            <CardHeader
              title={a.title}
              description={`${a.category}${a.published_at ? ` · published ${formatDay(a.published_at)}` : ""}${tally.get(a.id) ? ` · helpful ${tally.get(a.id)!.yes}, not helpful ${tally.get(a.id)!.no}` : ""}`}
              actions={<Badge tone={a.status === "published" ? "green" : "gray"}>{a.status === "published" ? "Published" : a.status === "draft" ? "Draft" : "Retired"}</Badge>}
            />
            <CardBody>{canEdit ? <HelpArticleForm article={a} /> : <p className="text-sm whitespace-pre-line text-ink">{a.body}</p>}</CardBody>
          </Card>
        ))
      ) : (
        <EmptyState title="No help articles yet" description="Write answers to the questions your customers ask most: ordering, delivery windows, site access, tickets." />
      )}
    </div>
  );
}
