import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/server/env";
import { cookiePersistence, SHARED_DEVICE_COOKIE } from "@/lib/shared-device";

/**
 * Supabase client bound to the signed-in user's session. Every query runs
 * with the user's identity, so Row Level Security applies.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = env();
  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          const shared = cookieStore.get(SHARED_DEVICE_COOKIE)?.value === "1";
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, cookiePersistence(options, shared)));
        } catch {
          // Called from a Server Component: cookies are refreshed by src/proxy.ts instead.
        }
      },
    },
  });
}
