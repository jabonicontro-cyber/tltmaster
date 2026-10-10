import "server-only";
import { buildQuoteDocument } from "@/lib/quotes/document";
import { getQuoteVersion } from "@/server/data/quotes";
import { getSettings } from "@/server/data/settings";

/** Load a version and build its customer-facing document (RLS applies). */
export async function loadQuoteDocument(quoteId: string, versionId: string) {
  const [data, settings] = await Promise.all([getQuoteVersion(quoteId, versionId), getSettings()]);
  if (!data) return null;
  return { ...data, doc: buildQuoteDocument({ ...data, settings }) };
}
