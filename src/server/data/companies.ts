import "server-only";
import { createClient } from "@/server/supabase/server";

export interface MyCompany {
  company_id: string;
  name: string;
  role: string;
  current: boolean;
}

/** The signed-in user's active memberships (for the company switcher). */
export async function myCompanies(): Promise<MyCompany[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("my_companies");
  return (data ?? []) as MyCompany[];
}
