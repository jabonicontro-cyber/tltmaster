import "server-only";
import { cache } from "react";
import { modulesOff, type ModuleKey } from "@/lib/modules";
import { getSettings } from "@/server/data/settings";

/**
 * The company's switched-off workflow modules (MOD1, docs/MODULES.md), once per request. Empty when the settings
 * cannot be read or the column is not installed yet (20261120023000): every module on, as before.
 */
export const getModulesOff = cache(async (): Promise<ModuleKey[]> => {
  const s = await getSettings().catch(() => null);
  return modulesOff((s as { modules_off?: unknown } | null)?.modules_off);
});

export async function moduleIsOn(key: ModuleKey): Promise<boolean> {
  return !(await getModulesOff()).includes(key);
}
