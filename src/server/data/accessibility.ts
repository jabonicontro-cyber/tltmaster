import "server-only";
import { parseAccessibility, type AccessibilitySettings } from "@/lib/accessibility";
import { createClient } from "@/server/supabase/server";

/**
 * The signed-in person's accessibility settings (migration 20261120007300). Null when none are saved yet or before
 * the migration is installed: the page then keeps whatever this browser has.
 */
export async function getMyAccessibility(): Promise<AccessibilitySettings | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("user_accessibility").select("settings").maybeSingle();
  if (error || !data) return null;
  return parseAccessibility((data as { settings: unknown }).settings);
}
