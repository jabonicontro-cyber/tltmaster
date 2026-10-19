import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { isPortalSlug, type PortalCompany, type PortalContext } from "@/lib/portal";

// Customer portal data (B66). Every read goes through a portal_* database function that derives the company and the
// customer from the signed-in account; nothing here passes a company or customer id. Before the portal migration
// (20261120000700) is applied the functions do not exist and every portal page shows "not available".

export type PortalGate =
  | { kind: "customer"; context: PortalContext }
  | { kind: "signed-out"; company: (PortalCompany & { public_page: boolean }) | null }
  | { kind: "no-access"; company: (PortalCompany & { public_page: boolean }) | null };

const NOT_INSTALLED = /could not find the function|does not exist|schema cache/i;

/** The public card (null when the company has no open portal, or the database does not have the portal yet). */
export const portalPublic = cache(async (slug: string): Promise<(PortalCompany & { public_page: boolean }) | null> => {
  if (!isPortalSlug(slug)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_public", { p_slug: slug });
  if (error) return null;
  return (data as (PortalCompany & { public_page: boolean }) | null) ?? null;
});

/** Who is looking at this portal: a signed-in customer of it, someone signed out, or someone without access. */
export const portalGate = cache(async (slug: string): Promise<PortalGate> => {
  if (!isPortalSlug(slug)) notFound();
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return { kind: "signed-out", company: await portalPublic(slug) };
  const { data, error } = await supabase.rpc("portal_context", { p_slug: slug });
  if (error || !data) return { kind: "no-access", company: await portalPublic(slug) };
  return { kind: "customer", context: data as PortalContext };
});

/** For customer pages: the context, or a redirect to this portal's sign-in. */
export async function requirePortalCustomer(slug: string, next: string): Promise<PortalContext> {
  const gate = await portalGate(slug);
  if (gate.kind === "customer") return gate.context;
  redirect(`/portal/${slug}/login?next=${encodeURIComponent(next)}`);
}

/** Call a customer portal function; a refusal or a missing record becomes "not found". */
export async function portalCall<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (!NOT_INSTALLED.test(error.message)) console.warn("Portal read refused", { fn, code: error.code });
    notFound();
  }
  return data as T;
}

/** The signed-in person's portals (empty for staff, or before the migration). */
export async function myPortals(): Promise<Array<{ slug: string; company: string; open: boolean }>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_my_accounts");
  if (error) return [];
  return (data as Array<{ slug: string; company: string; open: boolean }>) ?? [];
}

/** A database message safe to show a customer (our own raise messages), or a generic one. */
export function portalError(error: { code?: string; message: string } | null): string {
  if (!error) return "Something went wrong. Please try again.";
  if (["22023", "23505", "54000", "P0001", "P0002"].includes(error.code ?? "")) return error.message;
  if (error.code === "42501") return "This is not available. Sign in again or contact us.";
  return "Something went wrong. Please try again.";
}

/** The platform owner's Testing Lab preview of this (demo) portal, if one is running. Null for everyone else. */
export async function portalPreview(slug: string): Promise<{ customer: string; expires_at: string } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("portal_preview_state", { p_slug: slug });
  if (error) return null;
  return (data as { customer: string; expires_at: string } | null) ?? null;
}
