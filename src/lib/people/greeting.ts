/**
 * The first name to greet someone by, from their own profile name. Returns null
 * when there is nothing usable (empty, an email address, or no letters), so the
 * caller falls back to a neutral greeting rather than guessing.
 */
export function firstNameOf(fullName: string | null | undefined): string | null {
  const name = (fullName ?? "").trim();
  if (!name || name.includes("@")) return null;
  const first = name.split(/\s+/)[0].replace(/[,;:]+$/, "");
  if (!/\p{L}/u.test(first) || first.length > 40) return null;
  return first;
}

/** "Hi, Pat!" — or "Welcome back!" when no first name is known. */
export function greeting(fullName: string | null | undefined): string {
  const first = firstNameOf(fullName);
  return first ? `Hi, ${first}!` : "Welcome back!";
}
