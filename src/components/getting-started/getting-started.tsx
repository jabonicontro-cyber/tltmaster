import { CHECKLIST_ROLE_WORDS, type ChecklistPlace, type GettingStartedFacts } from "@/lib/getting-started";
import type { Access } from "@/lib/permissions";
import { loadGettingStarted } from "@/server/data/getting-started";
import { GettingStartedCard } from "./getting-started-card";

/**
 * The "Getting started" checklist on a landing page, for the role that lands there (Command Center: owner, office,
 * dispatcher; My Day: driver; My jobs: mechanic). Renders nothing for anyone else, in presentation mode, once put
 * away or once every step is done. A failure to read it never breaks the page.
 */
export async function GettingStarted({ access, place, facts }: { access: Access; place: ChecklistPlace; facts?: GettingStartedFacts }) {
  const view = await loadGettingStarted(access, place, facts).catch(() => null);
  if (!view) return null;
  return <GettingStartedCard items={view.items} storageKey={view.storageKey} roleLabel={CHECKLIST_ROLE_WORDS[view.role]} />;
}
