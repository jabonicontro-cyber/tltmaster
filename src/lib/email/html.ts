// The branded HTML version of a Taviron email, sent alongside the plain text.
// Pure and dependency-free so it is unit-tested: every value is escaped, links
// are allowed only for https: and mailto: (anything else is dropped, never
// rendered), and styles are inline because mail clients ignore <style>. Light
// palette only (navy header, cloud background, action-blue button): mail
// clients do not follow the app's theme.

export interface EmailLayout {
  /** Shown by mail clients next to the subject; never visible in the body. */
  preheader?: string;
  heading: string;
  /** Paragraphs of plain text; line breaks inside one are kept. */
  paragraphs: string[];
  /** Label/value pairs shown as a table, e.g. a lead's details. Empty values show "—". */
  details?: Array<[string, string]>;
  /** One primary button. Dropped when the URL is not https: or mailto:. */
  action?: { label: string; url: string };
  /** Small print at the bottom (why the person received this email). */
  footer: string;
}

const NAVY = "#0c1a2b";
const ACTION = "#0f6fd6";
const CLOUD = "#f7f9fc";
const LINE = "#c7d1de";
const MUTED = "#4a5a70";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** The URL if it is an absolute https: or mailto: address, otherwise null. */
export function safeEmailUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "mailto:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const text = (s: string) => escapeHtml(s).replace(/\r?\n/g, "<br>");

export function renderEmailHtml(layout: EmailLayout): string {
  const url = layout.action ? safeEmailUrl(layout.action.url) : null;
  const paragraphs = layout.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:${NAVY};">${text(p)}</p>`)
    .join("");
  const details = layout.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 20px;">${layout.details
        .map(
          ([label, value]) =>
            `<tr><td style="padding:8px 12px 8px 0;border-top:1px solid ${LINE};font-size:14px;color:${MUTED};vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>` +
            `<td style="padding:8px 0;border-top:1px solid ${LINE};font-size:14px;color:${NAVY};vertical-align:top;">${value.trim() ? text(value) : "—"}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const button =
    url && layout.action
      ? `<p style="margin:8px 0 24px;"><a href="${escapeHtml(url)}" style="display:inline-block;background:${ACTION};color:#ffffff;text-decoration:none;font-weight:600;font-size:16px;line-height:20px;padding:12px 20px;border-radius:8px;">${escapeHtml(layout.action.label)}</a></p>`
      : "";
  const preheader = layout.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(layout.preheader)}</div>`
    : "";
  return [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="color-scheme" content="light"><title>${escapeHtml(layout.heading)}</title></head>`,
    `<body style="margin:0;padding:0;background:${CLOUD};font-family:${FONT};">${preheader}`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CLOUD};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:12px;overflow:hidden;">`,
    `<tr><td style="background:${NAVY};padding:16px 24px;color:#ffffff;font-size:16px;font-weight:700;letter-spacing:3px;">TAVIRON</td></tr>`,
    `<tr><td style="padding:28px 24px 8px;">`,
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:28px;color:${NAVY};">${escapeHtml(layout.heading)}</h1>`,
    paragraphs,
    details,
    button,
    `</td></tr>`,
    `<tr><td style="padding:16px 24px 24px;border-top:1px solid ${LINE};font-size:12px;line-height:18px;color:${MUTED};">${text(layout.footer)}</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join("");
}
