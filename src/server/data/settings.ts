import "server-only";
import { cache } from "react";
import { createClient } from "@/server/supabase/server";
import { DEFAULT_TIMEZONE, todayIn } from "@/lib/dates";
import type { CompanySettings } from "./types";

export const getSettings = cache(async (): Promise<CompanySettings> => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("company_settings").select("*").maybeSingle();
  if (error || !data) throw new Error("Could not load company settings.");
  const { brand_logo, ...rest } = data as Omit<CompanySettings, "has_logo"> & { brand_logo?: string };
  return { ...rest, has_logo: Boolean(brand_logo) } as CompanySettings;
});

export async function businessToday(): Promise<{ today: string; timezone: string }> {
  const s = await getSettings();
  const timezone = s.timezone || DEFAULT_TIMEZONE;
  return { today: todayIn(timezone), timezone };
}
