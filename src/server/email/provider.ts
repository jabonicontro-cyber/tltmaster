import "server-only";
import { env } from "@/server/env";

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface OutgoingEmail {
  to: string[];
  cc: string[];
  replyTo?: string;
  subject: string;
  text: string;
  /** Optional branded HTML version (src/lib/email/html.ts); the text is always sent too. */
  html?: string;
  attachments: EmailAttachment[];
}

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string; retryable: boolean };

export interface EmailProvider {
  name: string;
  /** idempotencyKey makes a retried request safe: the provider sends at most once per key. */
  send(email: OutgoingEmail, opts: { idempotencyKey: string }): Promise<SendResult>;
}

export type EmailMode =
  | { mode: "preview"; reason: string }
  | { mode: "test"; provider: EmailProvider; testRecipient: string }
  | { mode: "live"; provider: EmailProvider };

/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendProvider implements EmailProvider {
  name = "resend";
  constructor(
    private apiKey: string,
    private from: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(email: OutgoingEmail, opts: { idempotencyKey: string }): Promise<SendResult> {
    const first = await this.attempt(email, opts.idempotencyKey);
    if (first.ok || !first.retryable) return first;
    // One safe retry: the idempotency key prevents a duplicate email.
    await new Promise((r) => setTimeout(r, 1500));
    return this.attempt(email, opts.idempotencyKey);
  }

  private async attempt(email: OutgoingEmail, idempotencyKey: string): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to: email.to,
          cc: email.cc.length ? email.cc : undefined,
          reply_to: email.replyTo || undefined,
          subject: email.subject,
          text: email.text,
          html: email.html || undefined,
          attachments: email.attachments.map((a) => ({
            filename: a.filename,
            content: a.content.toString("base64"),
            content_type: a.contentType,
          })),
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      return { ok: false, error: `Email service unreachable: ${e instanceof Error ? e.message : "network error"}`, retryable: true };
    }
    let body: { id?: string; message?: string; name?: string } = {};
    try {
      body = await response.json();
    } catch {
      // ignore body parse errors
    }
    if (!response.ok) {
      return {
        ok: false,
        error: `Email service rejected the message (${response.status}${body.message ? `: ${body.message}` : ""}).`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    return { ok: true, providerMessageId: body.id ?? null };
  }
}

/** Decide how emails are handled from configuration. Never pretends to send. */
export function getEmailMode(): EmailMode {
  const e = env();
  if (e.EMAIL_PROVIDER !== "resend") {
    return { mode: "preview", reason: "Email sending is not configured (EMAIL_PROVIDER=preview). Nothing will be sent." };
  }
  if (!e.RESEND_API_KEY || !e.EMAIL_FROM) {
    return { mode: "preview", reason: "EMAIL_PROVIDER is resend but RESEND_API_KEY or EMAIL_FROM is missing. Nothing will be sent." };
  }
  const provider = new ResendProvider(e.RESEND_API_KEY, e.EMAIL_FROM);
  if (e.EMAIL_TEST_RECIPIENT) return { mode: "test", provider, testRecipient: e.EMAIL_TEST_RECIPIENT };
  return { mode: "live", provider };
}

export function emailStatusSummary(): { mode: EmailMode["mode"]; description: string; from?: string } {
  const m = getEmailMode();
  const e = env();
  if (m.mode === "preview") return { mode: "preview", description: m.reason };
  if (m.mode === "test") return { mode: "test", description: `Test mode: every email goes to ${m.testRecipient} and quotes are not marked sent.`, from: e.EMAIL_FROM };
  return { mode: "live", description: "Emails are delivered to customers through Resend.", from: e.EMAIL_FROM };
}
