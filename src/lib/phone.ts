// Progressive phone formatting for inputs (pure functions; the PhoneInput
// component applies them while typing). US numbers are shown as (123) 456-7890
// as the digits arrive; numbers starting with "+" are international and left as
// typed (only allowed characters kept); an extension ("x123", "ext 123") is kept.
// The result always passes the existing server rule (optionalPhone), so stored
// values stay compatible; existing values are only reformatted when edited.

const EXT = /\s*(?:x|ext\.?)\s*(\d{0,6})\s*$/i;

/** Digits of the US part, without a leading country code 1 when there are 11. */
function usDigits(digits: string): { country: string; local: string } {
  if (digits.length === 11 && digits.startsWith("1")) return { country: "1", local: digits.slice(1) };
  return { country: "", local: digits };
}

function formatLocal(d: string): string {
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6, 10)}`;
}

/** Format what the person typed or pasted. Idempotent: formatPhone(formatPhone(x)) === formatPhone(x). */
export function formatPhone(input: string): string {
  const raw = input.replace(/[^\d+()\-.\sxXeEtT]/g, "");
  if (raw.trimStart().startsWith("+")) {
    // International: keep the person's own grouping; only allowed characters.
    return raw.replace(/[^\d+()\-.\s]/g, "").replace(/(?!^)\+/g, "").replace(/\s{2,}/g, " ").slice(0, 40);
  }
  const ext = EXT.exec(raw);
  const main = ext ? raw.slice(0, ext.index) : raw;
  const digits = main.replace(/\D/g, "");
  if (digits.length > 11) return digits.slice(0, 15); // not a US number: digits only, never mangled
  const { country, local } = usDigits(digits);
  const body = (country ? "+1 " : "") + formatLocal(local);
  return ext ? `${body} x${ext[1]}` : body;
}

/** True when the value is empty or a complete number the server accepts. */
export function isCompletePhone(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v.startsWith("+")) return v.replace(/\D/g, "").length >= 7;
  const main = v.replace(EXT, "");
  const digits = main.replace(/\D/g, "");
  return digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}

const isCounted = (c: string) => /\d/.test(c);

/** Where the caret belongs in `formatted` so it stays after the same number of digits as in `raw` at `caret`. */
export function caretAfterFormat(raw: string, caret: number, formatted: string): number {
  const before = Array.from(raw.slice(0, caret)).filter(isCounted).length;
  if (before === 0) return formatted.startsWith("+1 ") && caret > 0 ? 3 : 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (isCounted(formatted[i])) seen++;
    if (seen === before) return i + 1;
  }
  return formatted.length;
}

/**
 * Backspace right after a formatting character (")", " ", "-") would otherwise
 * delete nothing visible and look stuck: delete the digit before it instead.
 * Returns the new raw value and caret, or null to let the browser handle it.
 */
export function backspaceOverFormatting(value: string, caret: number): { value: string; caret: number } | null {
  if (caret <= 0 || value.startsWith("+") && !value.startsWith("+1 ")) return null;
  const prev = value[caret - 1];
  if (isCounted(prev)) return null;
  let i = caret - 1;
  while (i > 0 && !isCounted(value[i - 1])) i--;
  if (i === 0) return null;
  return { value: value.slice(0, i - 1) + value.slice(caret), caret: i - 1 };
}
