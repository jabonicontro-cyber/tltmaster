import "server-only";
import { HELP_ARTICLES } from "@/lib/help/articles";
import { GUIDES } from "@/lib/help/guides";
import { visibleArticles } from "@/lib/help/search";
import type { Permission } from "@/lib/permissions";
import type { GuideEntry, HelpIndexEntry } from "@/components/help/help-panel";
import { createClient } from "@/server/supabase/server";

// Help Center data (B65). Articles and guides come from the repository; what a person may see follows their real
// permissions from the session. Feedback, searches and support requests are stored by 20261120000400 when installed;
// before that, Help still works and simply does not record them.

export function helpFor(permissions: readonly Permission[]) {
  const articles = visibleArticles(HELP_ARTICLES, permissions);
  const guides = GUIDES.filter((g) => g.permissions.length === 0 || g.permissions.some((p) => permissions.includes(p)));
  return { articles, guides };
}

/** The compact index and guides the header Help panel needs (no article bodies). */
export function helpPanelData(permissions: readonly Permission[]): { index: HelpIndexEntry[]; guides: GuideEntry[] } {
  const { articles, guides } = helpFor(permissions);
  return {
    index: articles.map((a) => ({ id: a.id, title: a.title, summary: a.summary, routes: a.routes, category: a.category, taskTitles: a.tasks.map((t) => t.title) })),
    guides: guides.map((g) => ({ id: g.id, title: g.title, summary: g.summary, start: g.steps[0].href ?? g.steps[0].route.replace(/\/\*$/, "") })),
  };
}

/** Record a search and how many results it had (query only; nothing about the page or person). */
export async function logHelpSearch(query: string, results: number): Promise<void> {
  const q = query.trim().replace(/\s+/g, " ").slice(0, 120);
  if (!q) return;
  const supabase = await createClient();
  await supabase.from("help_searches").insert({ query: q, results });
}

/** This person's answer to "Did this help?" for an article, if any. */
export async function myFeedback(articleId: string): Promise<boolean | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("help_feedback").select("helpful").eq("article_id", articleId).maybeSingle();
  if (error) return null;
  return (data as { helpful: boolean } | null)?.helpful ?? null;
}

/** This person's recent support requests (theirs only, by RLS). Null when Help storage is not installed. */
export async function mySupportRequests(): Promise<Array<{ id: string; message: string; status: string; created_at: string; page: string }> | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("help_support_requests").select("id, message, status, created_at, page").order("created_at", { ascending: false }).limit(10);
  if (error) return null;
  return (data ?? []) as Array<{ id: string; message: string; status: string; created_at: string; page: string }>;
}
