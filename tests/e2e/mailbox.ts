import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The local mail catcher's folder (scripts/dev-stack/mailbox.mjs). MAILBOX_DIR when the tests run from another checkout
// than the one whose stack is running (for example a worktree).
const MAILBOX = path.resolve(process.env.MAILBOX_DIR ?? ".dev-stack/mail");

type Mail = { to: string[]; subject: string; body: string };

/** The newest email (after `after`, ms) to `to` that `pick` accepts, waiting up to 10 s. */
async function newestMail<T>(to: string, after: number, pick: (m: Mail) => T | null): Promise<T> {
  for (let i = 0; i < 40; i++) {
    if (existsSync(MAILBOX)) {
      const files = readdirSync(MAILBOX).filter((f) => Number(f.split("-")[0]) >= after).sort().reverse();
      for (const f of files) {
        const m = JSON.parse(readFileSync(path.join(MAILBOX, f), "utf8")) as Mail;
        if (m.to.some((t) => t.toLowerCase() === to.toLowerCase())) {
          const found = pick(m);
          if (found) return found;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No email for ${to}. Is the dev mailbox running (scripts/dev-stack/stack.sh up)?`);
}

/** The newest email the local mail catcher received for an address (waits up to 10 s). Nothing leaves the machine. */
export async function latestMail(to: string, after: number): Promise<{ subject: string; link: string }> {
  return newestMail(to, after, (m) => {
    const link = (m.body.match(/href="([^"]+)"/) ?? [])[1]?.replace(/&amp;/g, "&");
    return link ? { subject: m.subject, link } : null;
  });
}

/**
 * The 6-digit code in the newest Supabase Auth email to an address (the confirmation template shows it as
 * {{ .Token }}). A stack still serving the older template without the code: the code is recovered from the link's
 * token hash, which Supabase Auth makes as sha224(email + code). Local test mailbox only.
 */
export async function latestCode(to: string, after: number): Promise<string> {
  return newestMail(to, after, (m) => {
    const shown = m.body.match(/code[^0-9]{0,80}(\d{6})\b/i)?.[1];
    if (shown) return shown;
    const hash = m.body.match(/token_hash=([0-9a-f]{56})/)?.[1];
    if (!hash) return null;
    for (let i = 0; i < 1_000_000; i++) {
      const code = String(i).padStart(6, "0");
      if (createHash("sha224").update(to.toLowerCase() + code).digest("hex") === hash) return code;
    }
    return null;
  });
}
