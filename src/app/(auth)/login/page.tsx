import type { Metadata } from "next";
import { siteGate } from "@/server/site-access";
import { LoginForm } from "../auth-forms";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <LoginForm next={next} gate={siteGate().enabled} />;
}
