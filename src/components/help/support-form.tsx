"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { sendSupportRequest } from "@/app/(app)/help/actions";

/**
 * Write → review → send. The review shows exactly what goes to the Taviron team (the message and, only if kept, the
 * page the person came from). The message never travels in a URL.
 */
export function SupportForm({ from, article }: { from: string; article?: string }) {
  const [message, setMessage] = useState("");
  const [includePage, setIncludePage] = useState(Boolean(from));
  const [reviewing, setReviewing] = useState(false);
  const tooShort = message.trim().length < 10;

  if (reviewing) {
    return (
      <form action={sendSupportRequest} className="space-y-4">
        <h2 className="text-base font-semibold">Review Before Sending</h2>
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="text-sm font-semibold text-muted">Message</p>
          <p className="mt-1 text-[15px] whitespace-pre-wrap">{message.trim()}</p>
          <p className="mt-3 text-sm font-semibold text-muted">Also sent</p>
          <p className="mt-1 text-sm">Your name and company, so the team can reply{includePage && from ? `, and the page you were on: ${from}` : ""}. Nothing else.</p>
        </div>
        <input type="hidden" name="message" value={message.trim()} />
        <input type="hidden" name="page" value={includePage ? from : ""} />
        {article ? <input type="hidden" name="article" value={article} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Send to Support</Button>
          <Button type="button" variant="secondary" onClick={() => setReviewing(false)}>Edit</Button>
        </div>
      </form>
    );
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="support-message" className="block text-sm font-semibold">What do you need help with?</label>
        <textarea id="support-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} rows={6} className="w-full rounded-control border border-line bg-card px-3 py-2 text-[15px] text-ink" />
        <p className="text-sm text-muted">Do not include passwords or card numbers.</p>
      </div>
      {from ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includePage} onChange={(e) => setIncludePage(e.target.checked)} className="size-4 accent-brand" /> Include the page I was on ({from})
        </label>
      ) : null}
      <Button type="button" disabled={tooShort} onClick={() => setReviewing(true)}>Review</Button>
      {tooShort && message ? <p className="text-sm text-muted">Write at least 10 characters.</p> : null}
    </div>
  );
}
