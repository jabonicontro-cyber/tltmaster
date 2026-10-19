import "server-only";
import { cache } from "react";
import { createClient } from "@/server/supabase/server";

// First sign-in setup state of the signed-in person (migration 20261120001200). null before that update.

export type MySetup = {
  required: boolean;
  expired?: boolean;
  kind?: "employee" | "portal";
  username?: string;
  company?: string;
  slug?: string;
  expires_at?: string;
};

export const mySetup = cache(async (): Promise<MySetup | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_account_setup");
  if (error) return null;
  return data as MySetup;
});

/** True when the person must finish first-time setup before anything else (the database refuses them meanwhile). */
export async function setupRequired(): Promise<boolean> {
  return Boolean((await mySetup())?.required);
}
