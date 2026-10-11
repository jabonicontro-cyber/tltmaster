import Link from "next/link";
import { Menu } from "lucide-react";
import { BrandMark } from "@/components/layout/brand";

const NAV = [
  { href: "/platform", label: "Platform" },
  { href: "/solutions", label: "Solutions" },
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

/** Public website header. The mobile menu is a <details> element: it works without JavaScript. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-[#111214]/90 backdrop-blur supports-[backdrop-filter]:bg-[#111214]/75">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Taviron home">
          <BrandMark />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-3 py-2 text-sm font-medium text-white/75 hover:bg-white/5 hover:text-white">
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <Link href="/login" className="rounded-md px-3 py-2 text-sm font-semibold text-white/80 hover:text-white">
            Sign in
          </Link>
          <Link href="/demo" className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-dark">
            Request a demo
          </Link>
        </div>
        <details className="group relative md:hidden">
          <summary className="flex cursor-pointer list-none items-center rounded-md p-2 text-white/85 hover:bg-white/10 [&::-webkit-details-marker]:hidden" aria-label="Menu">
            <Menu className="size-6" aria-hidden />
          </summary>
          <nav aria-label="Main" className="absolute right-0 mt-2 w-60 rounded-lg border border-white/10 bg-[#17181b] p-2 shadow-2xl">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="block rounded-md px-3 py-2.5 text-sm font-medium text-white/85 hover:bg-white/5">
                {n.label}
              </Link>
            ))}
            <div className="my-2 border-t border-white/10" />
            <Link href="/login" className="block rounded-md px-3 py-2.5 text-sm font-semibold text-white/85 hover:bg-white/5">
              Sign in
            </Link>
            <Link href="/demo" className="mt-1 block rounded-md bg-brand px-3 py-2.5 text-center text-sm font-semibold text-white hover:bg-brand-dark">
              Request a demo
            </Link>
          </nav>
        </details>
      </div>
    </header>
  );
}
