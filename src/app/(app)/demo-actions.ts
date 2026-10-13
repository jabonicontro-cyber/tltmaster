"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEMO_WELCOME_COOKIE, PRESENTATION_COOKIE, PREVIEW_COOKIE, parsePreviewRole, welcomeToken, withWelcomeToken } from "@/lib/platform/preview";
import { safeNextPath } from "@/lib/safe-redirect";
import { getAccess } from "@/server/auth";
import { requestIsHttps } from "@/server/site-access-request";
import { createClient } from "@/server/supabase/server";

/**
 * Show the demo company as another role (presentation only), or go back to
 * your own view. Only honored in a demo company; getAccess ignores the cookie
 * everywhere else, and a preview can only ever hide things.
 */
export async function setDemoPreview(formData: FormData) {
  const access = await getAccess();
  const next = safeNextPath(String(formData.get("next") ?? ""), "/command-center");
  const jar = await cookies();
  const role = parsePreviewRole(String(formData.get("role") ?? ""));
  if (!access?.isDemo || !role) {
    jar.delete(PREVIEW_COOKIE);
  } else {
    jar.set(PREVIEW_COOKIE, role, { httpOnly: true, sameSite: "lax", secure: await requestIsHttps(), path: "/", maxAge: 60 * 60 * 8 });
  }
  // The driver's home is the driver portal.
  redirect(role === "driver" ? "/driver" : next);
}

/**
 * Presentation mode for screenshots and live demos: hides the demo badge and
 * the welcome dialog. Only honored in a demo company; it hides no data,
 * alerts or warnings, and grants nothing.
 */
export async function setPresentationMode(formData: FormData) {
  const access = await getAccess();
  const next = safeNextPath(String(formData.get("next") ?? ""), "/command-center");
  const jar = await cookies();
  if (access?.isDemo && formData.get("on") === "1") {
    jar.set(PRESENTATION_COOKIE, "1", { httpOnly: true, sameSite: "lax", secure: await requestIsHttps(), path: "/", maxAge: 60 * 60 * 8 });
  } else {
    jar.delete(PRESENTATION_COOKIE);
  }
  redirect(next);
}

/**
 * The demo welcome was seen: remembered for this person in this demo company
 * (database, migration 20261109000100) and, as a fallback, in a browser cookie.
 * Does nothing outside a demo company.
 */
export async function dismissDemoWelcome(): Promise<void> {
  const access = await getAccess();
  if (!access?.isDemo || !access.companyId) return;
  const supabase = await createClient();
  // Refused only when the function is not installed yet; the cookie below still remembers it on this browser.
  await supabase.rpc("dismiss_demo_welcome");
  const jar = await cookies();
  jar.set(DEMO_WELCOME_COOKIE, withWelcomeToken(jar.get(DEMO_WELCOME_COOKIE)?.value, welcomeToken(access.companyId, access.userId)), {
    httpOnly: true, sameSite: "lax", secure: await requestIsHttps(), path: "/", maxAge: 60 * 60 * 24 * 365,
  });
}
