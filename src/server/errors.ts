import "server-only";
import { z } from "zod";
import { fail } from "@/lib/action-result";
import { PermissionError } from "@/server/auth";

interface DbError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

/** Turn a PostgREST / Postgres error into a message safe to show users. */
export function dbErrorMessage(error: DbError | null | undefined): string {
  if (!error) return "Something went wrong.";
  switch (error.code) {
    case "42501":
      return error.message?.startsWith("You do not have permission")
        ? error.message
        : "You do not have permission to do that.";
    case "PT409":
      return error.message ?? "This record was changed by someone else. Reload and try again.";
    case "23505":
      return "A record with the same name or code already exists.";
    case "23503":
      return "This record is linked to other records and cannot be changed that way.";
    case "23514":
      return "One of the values is not allowed. Check the form and try again.";
    case "P0001":
      // Raised deliberately by our database functions with a user-facing message.
      return error.message ?? "The request was rejected.";
    default:
      console.error("Database error", { code: error.code, message: error.message });
      return "The database could not complete the request. Please try again.";
  }
}

export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

export function validationFailure(error: z.ZodError) {
  return fail("Please correct the highlighted fields.", zodFieldErrors(error));
}

/** Wrap a server action body: converts permission errors and unexpected exceptions to a failed result. */
export async function guard<T>(fn: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PermissionError) return fail(e.message);
    // Let Next.js redirect / notFound control flow propagate.
    if (e && typeof e === "object" && "digest" in e) throw e;
    console.error("Unexpected server action error", e);
    return fail("Something went wrong on the server. Your changes were not saved.");
  }
}
