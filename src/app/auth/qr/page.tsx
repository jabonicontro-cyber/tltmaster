import type { Metadata } from "next";
import { BrandMark } from "@/components/layout/brand";
import { PRODUCT_NAME } from "@/lib/product";
import { QrSignIn } from "./qr-sign-in";

export const metadata: Metadata = { title: "Signing in", referrer: "no-referrer" };

/**
 * Where a scanned sign-in QR code opens (master plan DS1). The code's token is in the address's fragment, which never
 * reaches a server; the page reads it, clears it from the address bar and posts it once. Same frame as the sign-in page.
 */
export default function QrSignInPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-charcoal">
      <div className="h-1.5 bg-brand" />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center">
            <BrandMark className="scale-125" />
          </div>
          <div className="rounded-2xl bg-card p-6 shadow-xl">
            <QrSignIn />
          </div>
          <p className="mt-6 text-center text-xs text-white/50">{PRODUCT_NAME} · Authorized users only</p>
        </div>
      </main>
    </div>
  );
}
