import Link from "next/link";
import { TavironLogo } from "./logo";

const COLUMNS = [
  { title: "Product", links: [{ href: "/platform", label: "Platform" }, { href: "/solutions", label: "Solutions" }, { href: "/pricing", label: "Pricing" }] },
  { title: "Company", links: [{ href: "/about", label: "About" }, { href: "/contact", label: "Contact" }, { href: "/demo", label: "Request a demo" }] },
  { title: "Legal", links: [{ href: "/privacy", label: "Privacy" }, { href: "/terms", label: "Terms" }] },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-silver/10 bg-[#091422]">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="space-y-3">
          <TavironLogo />
          <p className="max-w-xs text-sm text-silver/80">Operations software for hauling companies: orders, dispatch, drivers, delivery tickets and billing readiness in one place.</p>
          <p className="text-xs text-silver/60">In early access. Taviron is a working product name.</p>
        </div>
        {COLUMNS.map((c) => (
          <div key={c.title}>
            <h2 className="text-sm font-semibold text-cloud">{c.title}</h2>
            <ul className="mt-3 space-y-2">
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-silver transition-colors hover:text-cloud">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}
