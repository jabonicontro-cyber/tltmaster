import { Badge } from "@/components/ui/badge";
import { mfaSetUpSummary, type MemberMfaStatus } from "@/lib/mfa-policy";
import { permissionWords } from "@/lib/permission-words";
import { ROLE_LABELS, type AppRole } from "@/lib/permissions";

/**
 * Settings → Security: who must use two-step verification because of money access (SEC4), named instead of described
 * (walkthrough 2026-11-11). The roles that hold a money permission in this company and, for people who manage users,
 * the people in them. Whether each person has set it up is MfaSetUp below (SEC4b). In a demo company money roles are
 * exempt (fictional data).
 */
export function MfaWho({ roles, demo, peopleShown, names = true }: {
  roles: Array<{ role: AppRole; permissions: string[]; people: Array<{ id: string; name: string }> }>;
  demo: boolean;
  /** The people are counted (users.manage); otherwise only the roles. */
  peopleShown: boolean;
  /** Name the people under each role (when MfaSetUp lists them with their state, the count is enough). */
  names?: boolean;
}) {
  return (
    <section aria-label="Who must use two-step verification" className="space-y-2" data-testid="mfa-who">
      <p className="text-sm font-semibold text-ink">Always required, whatever the setting below</p>
      {demo ? (
        <p className="text-sm text-muted" data-testid="mfa-demo-exempt">
          This is a demo company: the money in it is fictional, so these roles are not asked for a code here. In a real company they always are.
        </p>
      ) : (
        <p className="text-sm text-muted">People in a role that can see or change money, settings or sign-ins. Change the roles in Settings → Roles and permissions.</p>
      )}
      {roles.length === 0 ? (
        <p className="text-sm text-muted">No role in this company holds a money permission.</p>
      ) : (
        <ul className="divide-y divide-line/70 rounded-xl ring-1 ring-line/60">
          {roles.map((r) => (
            <li key={r.role} className="px-4 py-3 text-sm" aria-label={ROLE_LABELS[r.role] ?? r.role}>
              <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                {ROLE_LABELS[r.role] ?? r.role}
                {peopleShown && <Badge tone="gray">{r.people.length} {r.people.length === 1 ? "person" : "people"}</Badge>}
              </p>
              <p className="mt-0.5 text-muted">Because of: {r.permissions.map((p) => permissionWords(p)).filter((w) => w !== "this page").join(", ") || "a money permission"}.</p>
              {peopleShown && names && r.people.length > 0 && <p className="mt-0.5 text-ink">{r.people.map((p) => p.name).join(", ")}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Settings → Security, for people who manage users (owner 2026-11-12, "Yes, show it"; SEC4b): who has set up two-step
 * verification, from public.company_mfa_status (20261120019900). Each person's name and role as the people list shows
 * them, why they must use it, and their state in plain words; never a factor, code or phone number.
 */
export function MfaSetUp({ statuses, installed }: { statuses: MemberMfaStatus[] | null; installed: boolean }) {
  const summary = statuses ? mfaSetUpSummary(statuses) : null;
  return (
    <section aria-label="Who has set up two-step verification" className="space-y-2" data-testid="mfa-set-up">
      <p className="text-sm font-semibold text-ink">Who has set it up</p>
      {!statuses ? (
        <p className="text-sm text-muted">
          {installed ? "Who has set it up could not be read right now. Reload the page to try again." : "Who has set it up shows here after a database update that has not been installed yet."}
        </p>
      ) : (
        <>
          <p className="text-sm text-ink" data-testid="mfa-set-up-summary">{summary ?? "Nobody here must use two-step verification right now."}</p>
          {statuses.length > 0 && (
            <ul className="divide-y divide-line/70 rounded-xl ring-1 ring-line/60" aria-label="Two-step verification by person">
              {statuses.map((s) => (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 px-4 py-3 text-sm" aria-label={s.name}>
                  <div className="min-w-0">
                    <p className="font-medium break-words text-ink">{s.name}</p>
                    <p className="text-muted">
                      {(s.role && ROLE_LABELS[s.role as AppRole]) || "No role yet"}
                      {s.reason ? ` · Must use it: ${s.reason === "Money access" ? "money access" : "company rule"}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-col items-start gap-1 sm:items-end">
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {s.detail && <span className="text-xs text-muted sm:text-right">{s.detail}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
