import "server-only";
import { z } from "zod";

// Required: without these nothing works, so a missing or malformed value stops the server loudly.
const core = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

// Optional settings are checked one by one. A malformed optional value must not
// take the whole site (and sign-in) down: it is dropped, named in
// `invalidSettings`, and anything that depends on it fails safe (see
// getEmailMode: any invalid email setting means nothing is sent).
const optional = {
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  APP_BASE_URL: z.url({ protocol: /^https?$/ }),
  EMAIL_PROVIDER: z.enum(["preview", "resend"]),
  RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_-]+$/),
  /** "Name <address>" or a bare address. */
  EMAIL_FROM: z.string().refine((v) => z.email().safeParse(/<([^>]+)>\s*$/.exec(v)?.[1] ?? v).success, "Not an email address"),
  EMAIL_REPLY_TO: z.email(),
  EMAIL_TEST_RECIPIENT: z.email(),
  /** Where new website leads are announced (the Taviron team's inbox). */
  LEAD_NOTIFY_EMAIL: z.email(),
  /** QuickBooks Online app (Intuit developer portal; master plan B82). Server-only. */
  QBO_CLIENT_ID: z.string().min(10).max(200),
  QBO_CLIENT_SECRET: z.string().min(10).max(200),
  QBO_ENVIRONMENT: z.enum(["sandbox", "production"]),
} as const;

type OptionalKey = keyof typeof optional;

export interface ServerEnv {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  APP_BASE_URL: string;
  EMAIL_PROVIDER: "preview" | "resend";
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_REPLY_TO?: string;
  EMAIL_TEST_RECIPIENT?: string;
  LEAD_NOTIFY_EMAIL?: string;
  QBO_CLIENT_ID?: string;
  QBO_CLIENT_SECRET?: string;
  QBO_ENVIRONMENT: "sandbox" | "production";
  /** Names (never values) of optional settings that were set but malformed and are being ignored. */
  invalidSettings: OptionalKey[];
}

let cached: ServerEnv | null = null;

function blankToUndefined(value: string | undefined) {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** Parse the environment. Exported for tests; the app uses env(). */
export function parseEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = core.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment variables: ${fields}. See .env.example.`);
  }
  const invalidSettings: OptionalKey[] = [];
  const values: Partial<Record<OptionalKey, string>> = {};
  for (const key of Object.keys(optional) as OptionalKey[]) {
    const raw = blankToUndefined(source[key]);
    if (raw === undefined) continue;
    const r = optional[key].safeParse(raw);
    if (r.success) values[key] = raw;
    else invalidSettings.push(key);
  }
  return {
    ...parsed.data,
    SUPABASE_SERVICE_ROLE_KEY: values.SUPABASE_SERVICE_ROLE_KEY,
    APP_BASE_URL: (values.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    EMAIL_PROVIDER: (values.EMAIL_PROVIDER as ServerEnv["EMAIL_PROVIDER"] | undefined) ?? "preview",
    RESEND_API_KEY: values.RESEND_API_KEY,
    EMAIL_FROM: values.EMAIL_FROM,
    EMAIL_REPLY_TO: values.EMAIL_REPLY_TO,
    EMAIL_TEST_RECIPIENT: values.EMAIL_TEST_RECIPIENT,
    LEAD_NOTIFY_EMAIL: values.LEAD_NOTIFY_EMAIL,
    QBO_CLIENT_ID: values.QBO_CLIENT_ID,
    QBO_CLIENT_SECRET: values.QBO_CLIENT_SECRET,
    QBO_ENVIRONMENT: (values.QBO_ENVIRONMENT as ServerEnv["QBO_ENVIRONMENT"] | undefined) ?? "sandbox",
    invalidSettings,
  };
}

export function env(): ServerEnv {
  if (cached) return cached;
  cached = parseEnv(process.env);
  if (cached.invalidSettings.length) {
    // Names only — never the values, which may be secrets.
    console.error(`Ignoring malformed environment settings: ${cached.invalidSettings.join(", ")}. Email sending is off until they are fixed.`);
  }
  return cached;
}
