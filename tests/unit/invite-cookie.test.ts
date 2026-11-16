import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { INVITE_COOKIE_SECONDS, inviteCookieName, inviteHandoffHtml, isInvitePage } from "@/lib/invite-cookie";
import { proxy } from "@/proxy";

// Invitation links (security review 2026-11-16): the token in /join-company?token=… and /join-team?token=… is moved to
// an HttpOnly, SameSite=Strict cookie for that page only on the first request, and the browser moves on to the clean
// address, so the token does not stay in the history, logs or a "next=" address.
const TOKEN = "ab".repeat(32);

describe("invitation token handoff", () => {
  it("keeps the token in a strict, HttpOnly cookie for that page and moves on to the clean address", async () => {
    for (const page of ["/join-company", "/join-team"] as const) {
      const res = await proxy(new NextRequest(`http://localhost:3000${page}?token=${TOKEN}`, { headers: { accept: "text/html" } }));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      const body = await res.text();
      expect(body).toContain(`<meta http-equiv="refresh" content="0;url=${page}">`);
      expect(body).not.toContain(TOKEN);
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toContain(`${inviteCookieName(page, false)}=${TOKEN}`);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=strict/i);
      expect(cookie).toContain(`Path=${page}`);
      expect(cookie).toContain(`Max-Age=${INVITE_COOKIE_SECONDS}`);
    }
  });

  it("uses a Secure, __Secure- cookie over HTTPS", async () => {
    const res = await proxy(new NextRequest(`https://app.example.com/join-company?token=${TOKEN}`));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`__Secure-taviron-owner-invite=${TOKEN}`);
    expect(cookie).toMatch(/Secure/);
  });

  it("clears the cookie for a malformed token and never echoes it", async () => {
    const res = await proxy(new NextRequest("http://localhost:3000/join-team?token=%3Cscript%3E"));
    expect(res.headers.get("set-cookie")).toMatch(/taviron-team-invite=;/);
    expect(await res.text()).not.toMatch(/script/i);
  });

  it("applies only to the two invitation pages", () => {
    expect(isInvitePage("/join-company")).toBe(true);
    expect(isInvitePage("/join-team")).toBe(true);
    expect(isInvitePage("/join-company/x")).toBe(false);
    expect(isInvitePage("/login")).toBe(false);
    expect(inviteHandoffHtml("/join-team")).not.toContain("<script");
  });
});
