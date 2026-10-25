import type { ReactNode } from "react";
import { PRODUCT_NAME } from "@/lib/product";
import { BrandMark } from "@/components/layout/brand";
import { PUBLIC_WEBSITE_URL } from "@/lib/site/urls";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-charcoal">
      <div className="h-1.5 bg-brand" />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center">
            {/* The public website, in the same tab — not the app or this page. */}
            <a href={PUBLIC_WEBSITE_URL} aria-label="Taviron website" className="rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white">
              <BrandMark className="scale-125" />
            </a>
          </div>
          <div className="rounded-2xl bg-card p-6 shadow-xl">{children}</div>
          <p className="mt-6 text-center text-xs text-white/50">{PRODUCT_NAME} · Authorized users only</p>
        </div>
      </main>
    </div>
  );
}
