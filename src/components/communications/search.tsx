"use client";

import Link from "next/link";
import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormError, Input } from "@/components/ui/form";
import { formatDateTime } from "@/lib/dates";
import { search, type SearchHit } from "@/app/(app)/communications/actions";


/** Searches only what the caller may read (the database applies the same history rules as the conversation). */
export function CommSearch() {
  const [q, setQ] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ messages: SearchHit[]; announcements: Array<{ id: string; title: string; published_at: string }> } | null>(null);
  return (
    <div className="space-y-3">
      <form className="flex gap-2" onSubmit={async (e) => {
        e.preventDefault();
        setPending(true); setError(null);
        const r = await search(q);
        setPending(false);
        if (!r.ok) { setResult(null); return setError(r.error); }
        setResult(r.data);
      }}>
        <Input type="search" aria-label="Search messages and announcements" placeholder="Search messages…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="secondary" loading={pending} icon={<Search className="size-4" />}>Search</Button>
      </form>
      <FormError message={error} />
      {result && (
        result.messages.length + result.announcements.length === 0 ? <p className="text-sm text-muted">Nothing found.</p> : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {result.announcements.map((a) => (
              <li key={a.id} className="px-3 py-2 text-sm">
                <Link className="font-medium text-ink hover:underline" href={`/communications/announcements/${a.id}`}>Announcement: {a.title}</Link>
                <span className="ml-2 text-xs text-muted">{formatDateTime(a.published_at)}</span>
              </li>
            ))}
            {result.messages.map((m) => (
              <li key={m.id} className="px-3 py-2 text-sm">
                <Link className="block text-ink hover:underline" href={`/communications/c/${m.conversation_id}#m-${m.id}`}>{m.body}</Link>
                <span className="text-xs text-muted">{m.author} · {formatDateTime(m.created_at)}</span>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
