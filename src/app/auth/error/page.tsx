import Link from "next/link";
import { BrandMark } from "@/components/layout/brand";
import { buttonClasses } from "@/components/ui/button";

export default function AuthErrorPage() {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-charcoal px-4">
      <div className="w-full max-w-sm rounded-2xl bg-card p-6 text-center shadow-xl">
        <div className="mb-4 flex justify-center">
          <BrandMark tone="dark" />
        </div>
        <h1 className="text-lg font-bold">This link is invalid or has expired</h1>
        <p className="mt-2 text-sm text-muted">Request a new password-reset link, or ask your administrator to resend your invitation.</p>
        <div className="mt-5 flex justify-center gap-2">
          <Link href="/forgot-password" className={buttonClasses("primary")}>
            Request new link
          </Link>
          <Link href="/login" className={buttonClasses("secondary")}>
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
