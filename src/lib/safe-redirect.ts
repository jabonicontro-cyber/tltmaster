/**
 * Only allow same-site relative paths as post-login destinations. Control
 * characters are refused too: browsers drop tabs and line breaks from URLs, so
 * "/<tab>/evil.example" would otherwise become "//evil.example" — another site.
 */
export function safeNextPath(next: string | null | undefined, fallback = "/command-center"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\u0000-\u001f\u007f]/.test(next)) return fallback;
  return next;
}

const RETURN_TARGETS: Array<{ prefix: string; label: string }> = [
  { prefix: "/command-center", label: "Back to the Command Center" },
  { prefix: "/tickets", label: "Back to the ticket queue" },
  { prefix: "/billing", label: "Back to billing" },
  { prefix: "/dispatch", label: "Back to the dispatch board" },
  { prefix: "/orders", label: "Back to orders" },
];

/**
 * Where "back" returns to after opening a record from a queue — the exact list,
 * filter and position the user came from. Only known in-app list pages are
 * accepted (never an external or arbitrary URL).
 */
export function returnTarget(back: string | string[] | null | undefined): { href: string; label: string } | null {
  const v = Array.isArray(back) ? back[0] : back;
  if (!v || v.length > 500 || safeNextPath(v, "") !== v || /[\r\n]/.test(v)) return null;
  // The list page itself, with its query string (filters, page) and anchor.
  const t = RETURN_TARGETS.find((r) => v === r.prefix || v.startsWith(`${r.prefix}?`) || v.startsWith(`${r.prefix}#`));
  return t ? { href: v, label: t.label } : null;
}

/** A link to `path` that remembers the page the user is on now (see returnTarget). */
export function withReturn(path: string, back: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}back=${encodeURIComponent(back)}`;
}
