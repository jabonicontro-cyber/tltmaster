// What the signed-in company hauls, read once per request (getSettings is cached), for server pages and data loaders
// that word things for aggregate or freight (src/lib/industry.ts). Unknown or unreadable settings mean aggregate.
import "server-only";
import { cache } from "react";
import { adaptWording, industryOf, vocabulary, type Industry, type Vocabulary } from "@/lib/industry";
import { getSettings } from "@/server/data/settings";

export const getIndustry = cache(async (): Promise<Industry> => industryOf((await getSettings().catch(() => null))?.industry));
export const getWords = cache(async (): Promise<Vocabulary> => vocabulary(await getIndustry()));

/** A function that rewords a fixed aggregate sentence for this company (adaptWording); identity for aggregate. */
export const getSay = cache(async (): Promise<(text: string) => string> => {
  const industry = await getIndustry();
  return (text: string) => adaptWording(text, industry);
});
