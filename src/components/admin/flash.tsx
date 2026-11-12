import { CheckCircle2 } from "lucide-react";
import { FormError } from "@/components/ui/form";

/**
 * The result of a form that redirected back with ?error= or ?saved= (?created= for a new company), shown at the top
 * of the page where the person is looking. One feedback per action: a page that shows this does not also toast the
 * same result (FlashToast is for short confirmations with nothing more to read). Theme tokens only, so it reads the
 * same in light and dark mode.
 */
export function AdminFlash({ error, saved, savedText = "Saved." }: { error?: string; saved?: string; savedText?: string }) {
  if (error) return <div className="mb-5"><FormError message={error.slice(0, 300)} /></div>;
  if (saved)
    return (
      <div role="status" className="mb-5 flex items-start gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm text-ink shadow-[0_1px_2px_rgb(12_26_43/0.04)]">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-green-50 text-green-700" aria-hidden>
          <CheckCircle2 className="size-4" />
        </span>
        <span className="min-w-0 pt-0.5">{savedText}</span>
      </div>
    );
  return null;
}
