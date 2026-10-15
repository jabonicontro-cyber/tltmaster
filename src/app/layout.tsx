import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { PRODUCT_NAME } from "@/lib/product";
import { THEME_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: "Operations management for hauling companies.",
  robots: { index: false, follow: false, nocache: true },
  // Companion app (docs/COMPANION_APP.md): installable from the phone's browser; the manifest is src/app/manifest.ts.
  appleWebApp: { capable: true, title: PRODUCT_NAME, statusBarStyle: "default" },
  icons: { apple: "/app-icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0c1a2b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme is set before paint by THEME_SCRIPT, so the server and client markup differ on <html> only.
    <html lang="en" suppressHydrationWarning>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2">
          Skip to content
        </a>
        {children}
        <Toaster />
        {/* Applies the saved light/dark choice early. next/script, not a raw <script>: a raw one in the layout stops router.refresh from updating the page. */}
        <Script id="taviron-theme" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </body>
    </html>
  );
}
