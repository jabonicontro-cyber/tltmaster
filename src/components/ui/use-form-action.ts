"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { ActionResult } from "@/lib/action-result";

/**
 * Submit a form to a server action without React's automatic form reset, so
 * the user's input is kept when the save fails. Ignores repeat submissions
 * while a request is in flight.
 */
export function useFormAction<T>(
  action: (formData: FormData) => Promise<ActionResult<T>>,
  opts: {
    onSuccess?: (result: { ok: true; data: T; message?: string }) => void;
    /** Called with the error when the action refuses (for a form that leaves the page, so the inline error would not be seen). */
    onError?: (error: string) => void;
  } = {},
) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult<T> | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      try {
        const res = await action(formData);
        setResult(res);
        if (res.ok) opts.onSuccess?.(res);
        else opts.onError?.(res.error);
      } catch (e) {
        // Redirects thrown by the action are handled by Next.js.
        if (e && typeof e === "object" && "digest" in e) throw e;
        setResult({ ok: false, error: "The server could not be reached. Your changes were not saved. Try again." });
      }
    });
  }

  const fieldError = (name: string) => (result && !result.ok ? result.fieldErrors?.[name] : undefined);
  const formError = result && !result.ok ? result.error : null;

  return { pending, result, onSubmit, fieldError, formError, reset: () => setResult(null) };
}
