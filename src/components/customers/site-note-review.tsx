"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Textarea } from "@/components/ui/form";
import { useFormAction } from "@/components/ui/use-form-action";
import { reviewSiteNote } from "@/app/(app)/customers/actions";

/** Apply a customer's site note to the site's directions (editable first) or decline it (B94). */
export function SiteNoteReview({ id, proposed }: { id: string; proposed: string }) {
  const router = useRouter();
  const { pending, onSubmit, formError } = useFormAction(reviewSiteNote, {
    onSuccess: (r) => {
      toast.success(r.message ?? "Saved.");
      router.refresh();
    },
  });
  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="Review site note">
      <FormError message={formError} />
      <input type="hidden" name="id" value={id} />
      <Field label="Directions drivers will see" htmlFor={`dir-${id}`} hint="Edit before applying. Applied directions are unverified until someone verifies them on the site.">
        <Textarea id={`dir-${id}`} name="directions" rows={6} maxLength={4000} defaultValue={proposed} />
      </Field>
      <Field label="Note (optional)" htmlFor={`note-${id}`}><Input id={`note-${id}`} name="note" maxLength={500} /></Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="apply" loading={pending}>Apply to the site</Button>
        <Button type="submit" name="decision" value="decline" variant="secondary" disabled={pending}>Decline</Button>
      </div>
    </form>
  );
}
