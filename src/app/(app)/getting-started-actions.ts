"use server";

import { getAccess } from "@/server/auth";
import { createClient } from "@/server/supabase/server";

/**
 * Put the "Getting started" checklist away for the signed-in person in the current company (migration
 * 20261120014100). Returns false when it could not be remembered on the account (the update is not installed yet, or
 * a Taviron support visit, which has no preferences of its own): the card then remembers it in this browser only.
 */
export async function dismissGettingStarted(): Promise<boolean> {
  const access = await getAccess();
  if (!access?.companyId) return false;
  const supabase = await createClient();
  const { error } = await supabase.rpc("dismiss_getting_started");
  return !error;
}
