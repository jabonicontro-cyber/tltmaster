import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const MAILBOX = path.resolve(".dev-stack/mail");

/** The newest email the local mail catcher received for an address (waits up to 10 s). Nothing leaves the machine. */
export async function latestMail(to: string, after: number): Promise<{ subject: string; link: string }> {
  for (let i = 0; i < 40; i++) {
    if (existsSync(MAILBOX)) {
      const files = readdirSync(MAILBOX).filter((f) => Number(f.split("-")[0]) >= after).sort().reverse();
      for (const f of files) {
        const m = JSON.parse(readFileSync(path.join(MAILBOX, f), "utf8")) as { to: string[]; subject: string; body: string };
        if (m.to.some((t) => t.toLowerCase() === to.toLowerCase())) {
          const link = (m.body.match(/href="([^"]+)"/) ?? [])[1]?.replace(/&amp;/g, "&");
          if (link) return { subject: m.subject, link };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No email for ${to}. Is the dev mailbox running (scripts/dev-stack/stack.sh up)?`);
}
