// The Content-Security-Policy (security review 2026-11-06, M4). Everything the browser loads comes from this site:
// fonts are self-hosted, map tiles are proxied (/api/map-tile), and photos and files are short-lived links on the
// database's storage host, reached through this site's own routes. Inline scripts stay allowed (Next.js and the theme
// script use them; a nonce would make every page dynamic), but no other site can run script, receive data, frame the
// app, take a form submission or change the base address.

export function contentSecurityPolicy(supabaseUrl: string | undefined, dev = false): string {
  let storage = "";
  try {
    storage = supabaseUrl ? new URL(supabaseUrl).origin : "";
  } catch {
    storage = "";
  }
  const src = (...extra: string[]) => ["'self'", ...extra.filter(Boolean)].join(" ");
  return [
    `default-src 'self'`,
    `script-src ${src("'unsafe-inline'", dev ? "'unsafe-eval'" : "")}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${src("data:", "blob:", storage)}`,
    `media-src ${src("blob:", storage)}`,
    `font-src 'self' data:`,
    `connect-src ${src(storage, dev ? "ws:" : "")}`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    `frame-src 'self' ${storage}`.trim(),
    `frame-ancestors 'self'`,
    `form-action 'self'`,
    `base-uri 'none'`,
    `object-src 'none'`,
  ].join("; ");
}
