import { Badge } from "@/components/ui/badge";
import { permissionWords } from "@/lib/permission-words";
import { ROLE_LABELS, type AppRole } from "@/lib/permissions";

/**
 * Settings → Security: who must use two-step verification because of money access (SEC4), named instead of described
 * (walkthrough 2026-11-11). The roles that hold a money permission in this company and, for people who manage users,
 * the people in them. Whether each person has set it up yet is not shown: no existing function reads another person's
 * authenticator, and that is not added for a list. In a demo company money roles are exempt (fictional data).
 */
export function MfaWho({ roles, demo, peopleShown }: {
  roles: Array<{ role: AppRole; permissions: string[]; people: Array<{ id: string; name: string }> }>;
  demo: boolean;
  /** The people are listed (users.manage); otherwise only the roles. */
  peopleShown: boolean;
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
              {peopleShown && r.people.length > 0 && <p className="mt-0.5 text-ink">{r.people.map((p) => p.name).join(", ")}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
