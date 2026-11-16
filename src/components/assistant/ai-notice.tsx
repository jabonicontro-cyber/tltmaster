"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { acknowledgeAiNotice } from "@/app/(app)/assistant/actions";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { FormError } from "@/components/ui/form";
import { AI_NOTICE } from "@/lib/ai/notice";

/**
 * Ask Taviron's first-use notice (master plan §11a): shown once per person and company before their first question.
 * Accepting records it on the server; the assistant refuses to answer until then (src/server/ai/gates.ts).
 */
export function AiNotice() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);
    const r = await acknowledgeAiNotice();
    setPending(false);
    if (!r.ok) return setError(r.error);
    toast.success(r.message ?? "Thanks.");
    router.refresh();
  }

  return (
    <Card className="max-w-3xl">
      <CardBody className="space-y-4">
        <h2 className="text-base font-semibold text-ink">{AI_NOTICE.title}</h2>
        <dl className="space-y-3 text-sm">
          {AI_NOTICE.points.map((p) => (
            <div key={p.heading}>
              <dt className="font-semibold text-ink">{p.heading}</dt>
              <dd className="mt-0.5 text-muted">{p.text}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm">
          <a href={AI_NOTICE.privacyHref} target="_blank" rel="noopener" className="font-semibold text-brand-fg hover:underline">{AI_NOTICE.privacyLabel}</a>
        </p>
        <FormError message={error} />
        <Button onClick={accept} loading={pending}>{AI_NOTICE.accept}</Button>
      </CardBody>
    </Card>
  );
}
