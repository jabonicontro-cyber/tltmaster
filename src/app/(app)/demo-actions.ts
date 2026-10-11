"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PRESENTATION_COOKIE, PREVIEW_COOKIE, parsePreviewRole } from "@/lib/platform/preview";
import { safeNextPath } from "@/lib/safe-redirect";
import { getAccess } from "@/server/auth";
import { requestIsHttps } from "@/server/site-access-request";

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
 * Presentation mode for screenshots and live demos: tucks the demo bar away
 * (its role switcher moves into the user menu). Only honored in a demo
 * company; it hides no data, alerts or warnings, and grants nothing.
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
