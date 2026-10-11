// Remembers the last view of each list page (its search, filters, sorting and
// page) for this browser tab, so "back" links return to exactly that view.
// Session storage only: nothing leaves the browser, and a new tab starts fresh.

const KEY = "taviron:list-view:";

/** List pages whose last view is remembered: one path segment (e.g. /orders, /tickets), or a fleet sub-list. */
export function isListPath(pathname: string): boolean {
  return /^\/[a-z-]+$/.test(pathname) || /^\/fleet\/(trucks|trailers|drivers)$/.test(pathname) || pathname === "/materials/price-lists";
}

/** Only same-path, same-origin views are ever returned (never another site or page). */
export function sanitizeRemembered(path: string, stored: string | null): string {
  if (!stored || !stored.startsWith(`${path}?`) || stored.length > 1000 || /[\u0000-\u001f\u007f]/.test(stored)) return path;
  return stored;
}

export function rememberListView(pathname: string, search: string): void {
  if (!isListPath(pathname)) return;
  try {
    if (search) sessionStorage.setItem(KEY + pathname, `${pathname}?${search}`);
    else sessionStorage.removeItem(KEY + pathname);
  } catch {
    // Storage unavailable (private mode, blocked): links simply go to the plain list.
  }
}

export function rememberedListView(path: string): string {
  try {
    return sanitizeRemembered(path, sessionStorage.getItem(KEY + path));
  } catch {
    return path;
  }
}
