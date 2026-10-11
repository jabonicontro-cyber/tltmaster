import { FormError } from "@/components/ui/form";

/** Result of a platform form (?error= / ?saved=), shown at the top of the page. */
export function AdminFlash({ error, saved, savedText = "Saved." }: { error?: string; saved?: string; savedText?: string }) {
  if (error) return <div className="mb-4"><FormError message={error.slice(0, 300)} /></div>;
  if (saved)
    return (
      <p role="status" className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
        {savedText}
      </p>
    );
  return null;
}
