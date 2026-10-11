import { describe, expect, it, vi } from "vitest";
import { escapeHtml, renderEmailHtml, safeEmailUrl } from "@/lib/email/html";
import { confirmationEmail, notificationEmail, type LeadForEmail } from "@/lib/site/lead-emails";
import { ResendProvider } from "@/server/email/provider";

const hostile: LeadForEmail = {
  kind: "demo",
  name: `Pat <script>alert("x")</script>`,
  email: "pat@example.com",
  company_name: `Acme & "Sons" <b>`,
  phone: "",
  truck_count: 18,
  base_count: null,
  message: "line one\nline <img src=x onerror=alert(1)>",
};

describe("branded HTML email", () => {
  it("escapes every value", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const html = renderEmailHtml({ heading: "<h>", paragraphs: ["<p>"], details: [["<l>", "<v>"]], footer: "<f>" });
    expect(html).not.toMatch(/<(h|p|l|v|f)>/);
    expect(html).toContain("&lt;v&gt;");
  });

  it("links only to https: and mailto: addresses", () => {
    expect(safeEmailUrl("https://mytaviron.com/admin/leads/1")).toBe("https://mytaviron.com/admin/leads/1");
    expect(safeEmailUrl("mailto:team@mytaviron.com")).toBe("mailto:team@mytaviron.com");
    for (const bad of ["javascript:alert(1)", "http://mytaviron.com", "/admin", "data:text/html,x"]) expect(safeEmailUrl(bad)).toBeNull();
    const html = renderEmailHtml({ heading: "H", paragraphs: [], action: { label: "Open", url: "javascript:alert(1)" }, footer: "F" });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain(">Open<");
  });

  it("keeps line breaks and shows missing values as a dash", () => {
    const html = renderEmailHtml({ heading: "H", paragraphs: ["a\nb"], details: [["Phone", "  "]], footer: "F" });
    expect(html).toContain("a<br>b");
    expect(html).toContain(">—<");
  });
});

describe("lead emails", () => {
  it("carry the same content as text and as escaped HTML", () => {
    const c = confirmationEmail(hostile);
    expect(c.text).toContain("Hello Pat,");
    expect(c.html).toContain("Hello Pat,");
    expect(c.html).not.toContain("<script>");
    expect(c.html).toContain("Acme &amp; &quot;Sons&quot; &lt;b&gt;");

    const n = notificationEmail(hostile, { leadUrl: "https://mytaviron.com/admin/leads/abc", created: true });
    expect(n.html).not.toMatch(/<script|<img/);
    expect(n.html).toContain("line one<br>line &lt;img");
    expect(n.html).toContain(`href="https://mytaviron.com/admin/leads/abc"`);
    expect(n.text).toContain("Dispatch bases: —");
  });

  it("drop the button when the lead link is not https (e.g. a misconfigured APP_BASE_URL)", () => {
    const n = notificationEmail(hostile, { leadUrl: "http://localhost:3000/admin/leads/abc", created: false });
    expect(n.html).not.toContain("Open the lead");
    expect(n.text).toContain("Open the lead: http://localhost:3000/admin/leads/abc");
    expect(n.subject).toContain("(sent again)");
  });
});

describe("ResendProvider with HTML", () => {
  it("sends the HTML next to the text, and omits it when there is none", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new ResendProvider("re_test", "Taviron <no-reply@mytaviron.com>", fetchImpl);
    await p.send({ to: ["a@example.com"], cc: [], subject: "S", text: "T", html: "<p>H</p>", attachments: [] }, { idempotencyKey: "k1" });
    await p.send({ to: ["a@example.com"], cc: [], subject: "S", text: "T", attachments: [] }, { idempotencyKey: "k2" });
    expect(bodies[0]).toMatchObject({ text: "T", html: "<p>H</p>" });
    expect(bodies[1]).not.toHaveProperty("html");
  });
});
