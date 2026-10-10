import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/server/supabase/server";
import { UpdatePasswordForm } from "../auth-forms";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function UpdatePasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  return <UpdatePasswordForm />;
}
