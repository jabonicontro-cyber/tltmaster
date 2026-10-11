import "server-only";
import { z } from "zod";

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  EMAIL_PROVIDER: z.enum(["preview", "resend"]).default("preview"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  EMAIL_REPLY_TO: z.string().optional(),
  EMAIL_TEST_RECIPIENT: z.email().optional(),
  /** Where new website leads are announced (the Taviron team's inbox). */
  LEAD_NOTIFY_EMAIL: z.email().optional(),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

function blankToUndefined(value: string | undefined) {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: blankToUndefined(process.env.SUPABASE_SERVICE_ROLE_KEY),
    APP_BASE_URL: blankToUndefined(process.env.APP_BASE_URL),
    EMAIL_PROVIDER: blankToUndefined(process.env.EMAIL_PROVIDER),
    RESEND_API_KEY: blankToUndefined(process.env.RESEND_API_KEY),
    EMAIL_FROM: blankToUndefined(process.env.EMAIL_FROM),
    EMAIL_REPLY_TO: blankToUndefined(process.env.EMAIL_REPLY_TO),
    EMAIL_TEST_RECIPIENT: blankToUndefined(process.env.EMAIL_TEST_RECIPIENT),
    LEAD_NOTIFY_EMAIL: blankToUndefined(process.env.LEAD_NOTIFY_EMAIL),
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment variables: ${fields}. See .env.example.`);
  }
  cached = parsed.data;
  return cached;
}
