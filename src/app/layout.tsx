import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter } from "next/font/google";
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
  // Browser tab: the Taviron emblem as SVG where supported; Next adds src/app/favicon.ico (same emblem) itself.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: "/app-icons/apple-touch-icon.png",
  },
};

// Inter is shipped with the app (self-hosted by next/font at build time; no request to Google from the browser).
// Before 2026-10-26 the app only named it, so computers without Inter drew another font and pill text sat off-centre.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const viewport: Viewport = {
  themeColor: "#0c1a2b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-theme is set before paint by THEME_SCRIPT, so the server and client markup differ on <html> only.
    <html lang="en" className={inter.variable} suppressHydrationWarning>
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
