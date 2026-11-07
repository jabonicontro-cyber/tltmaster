// Support change requests (SA2, migration 20261120009200). During a Taviron support visit, a change to who can sign in
// or what they may do is not made: the screen's own action is recorded, with only the form fields that action reads,
// for an owner to approve. Pure helpers (encoding and the message), shared by the server and the forms.

/** Every message that means "recorded for the owner, nothing changed yet" starts with this. */
export const APPROVAL_SENT = "Sent to an owner for approval:";

export function isApprovalSent(message: string | null | undefined): boolean {
  return Boolean(message?.startsWith(APPROVAL_SENT));
}

export function approvalSentMessage(summary: string): string {
  return `${APPROVAL_SENT} ${summary}. Nothing changes until an owner approves it in Settings, Taviron support.`;
}

export type EncodedArg = string | number | boolean | null | { $form: Array<[string, string]> };

/**
 * Encode an action's arguments for storage. FormData keeps only the listed fields (the ones the action reads), as
 * text; anything else (files, objects) cannot be sent for approval, so the result is null.
 */
export function encodeArgs(args: unknown[], formFields: readonly string[] = []): EncodedArg[] | null {
  const out: EncodedArg[] = [];
  for (const a of args) {
    if (a === null || a === undefined) out.push(null);
    else if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") out.push(a);
    else if (typeof FormData !== "undefined" && a instanceof FormData) {
      const entries: Array<[string, string]> = [];
      for (const [k, v] of a.entries()) {
        if (!formFields.includes(k)) continue;
        if (typeof v !== "string") return null;
        entries.push([k, v.slice(0, 2000)]);
      }
      out.push({ $form: entries });
    } else return null;
  }
  return out;
}

/** The arguments to replay, rebuilt from storage (forms become FormData again). Unknown shapes are refused. */
export function decodeArgs(stored: unknown): unknown[] | null {
  if (!Array.isArray(stored)) return null;
  const out: unknown[] = [];
  for (const a of stored) {
    if (a === null || typeof a === "string" || typeof a === "number" || typeof a === "boolean") out.push(a);
    else if (a && typeof a === "object" && Array.isArray((a as { $form?: unknown }).$form)) {
      const fd = new FormData();
      for (const pair of (a as { $form: unknown[] }).$form) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") return null;
        fd.append(pair[0], pair[1]);
      }
      out.push(fd);
    } else return null;
  }
  return out;
}

/** A field of a stored form (for describing it). */
export function formValue(arg: unknown, key: string): string {
  if (typeof FormData !== "undefined" && arg instanceof FormData) return String(arg.get(key) ?? "");
  return "";
}

/** One-time values an approved change can hand back (shown to the approving owner once, never stored). */
export const RESULT_FIELDS: Array<{ key: string; label: string; secret?: boolean }> = [
  { key: "personName", label: "Person" },
  { key: "customerName", label: "Customer" },
  { key: "username", label: "Username" },
  { key: "temporaryPassword", label: "Temporary password", secret: true },
  { key: "loginUrl", label: "Sign-in page" },
  { key: "link", label: "Invitation link" },
];

export function resultFields(data: unknown): Array<{ label: string; value: string; secret?: boolean }> {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  return RESULT_FIELDS.filter((f) => typeof d[f.key] === "string" && d[f.key]).map((f) => ({ label: f.label, value: String(d[f.key]), secret: f.secret }));
}
