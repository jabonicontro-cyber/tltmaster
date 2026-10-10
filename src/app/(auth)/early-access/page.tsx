import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/safe-redirect";
import { siteGate } from "@/server/site-access";
import { hasSiteAccess } from "@/server/site-access-request";
import { EarlyAccessForm } from "./early-access-form";

export const metadata: Metadata = { title: "Early Access" };

export default async function EarlyAccessPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Nothing to enter when the gate is off, or when this browser is already admitted.
  if (!siteGate().enabled || (await hasSiteAccess())) redirect(safeNextPath(next, "/login"));
  return <EarlyAccessForm next={next} />;
}
