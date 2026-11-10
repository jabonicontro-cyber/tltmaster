import type { Metadata } from "next";
import { passkeysAvailable } from "@/server/passkeys";
import { siteGate } from "@/server/site-access";
import { LoginForm } from "../auth-forms";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Face or fingerprint sign-in (DS1) only when the auth server offers passkeys; otherwise no button at all.
  return <LoginForm next={next} gate={siteGate().enabled} passkeys={await passkeysAvailable()} />;
}
