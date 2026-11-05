import type { Metadata } from "next";
import { TavironLogo } from "@/components/site/logo";
import { confirmUnsubscribe } from "./actions";

export const metadata: Metadata = { title: "Unsubscribe", robots: { index: false, follow: false } };

/**
 * The unsubscribe link in every outreach email (master plan B139). Public, no sign-in, and outside the early-access
 * gate. A button confirms it, so a mail scanner that opens links can't unsubscribe someone by accident.
 */
export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const { done } = await searchParams;
  return (
    <div className="site flex min-h-dvh flex-col bg-navy text-cloud">
      <header className="mx-auto flex w-full max-w-6xl items-center px-4 pt-6 sm:px-6"><TavironLogo /></header>
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {done ? (
            <>
              <h1 className="text-3xl font-bold tracking-tight text-cloud">You&apos;re unsubscribed.</h1>
              <p className="mt-4 text-silver">We won&apos;t email you about Taviron again. If you were contacted by mistake, you can also reply to the email and tell us.</p>
            </>
          ) : (
            <>
              <h1 className="text-3xl font-bold tracking-tight text-cloud">Stop emails from Taviron?</h1>
              <p className="mt-4 text-silver">Confirm below and we won&apos;t contact this address again.</p>
              <form action={confirmUnsubscribe} className="mt-6">
                <input type="hidden" name="token" value={token.slice(0, 64)} />
                <button type="submit" className="inline-flex h-11 items-center rounded-full bg-action px-6 font-semibold text-white hover:opacity-90">Unsubscribe</button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
