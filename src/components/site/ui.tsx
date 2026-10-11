import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-bold tracking-[0.25em] text-brand uppercase">{children}</p>;
}

export function PageIntro({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <section className="site-grid-bg relative overflow-hidden border-b border-white/10">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[48rem] -translate-x-1/2 rounded-full bg-brand/15 blur-3xl" aria-hidden />
      <Container className="relative py-16 sm:py-20">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-3 max-w-3xl text-4xl font-black tracking-tight text-white sm:text-5xl">{title}</h1>
        {children ? <div className="mt-5 max-w-2xl text-lg text-white/70">{children}</div> : null}
      </Container>
    </section>
  );
}

export function CtaLink({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "ghost" }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center justify-center rounded-md px-5 py-3 text-sm font-semibold transition-colors",
        variant === "primary" ? "bg-brand text-white shadow-lg shadow-brand/20 hover:bg-brand-dark" : "border border-white/20 text-white hover:border-white/40 hover:bg-white/5",
      )}
    >
      {children}
    </Link>
  );
}

/** A real screenshot of the app (fictional demo data), framed like a window. */
export function Screenshot({ src, alt, width, height, caption, className, priority }: { src: string; alt: string; width: number; height: number; caption?: string; className?: string; priority?: boolean }) {
  return (
    <figure className={cn("overflow-hidden rounded-xl border border-white/10 bg-[#0f1012] shadow-2xl shadow-black/50", className)}>
      <div className="flex items-center gap-1.5 border-b border-white/10 bg-white/[0.03] px-3 py-2" aria-hidden>
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
      </div>
      <Image src={src} alt={alt} width={width} height={height} className="h-auto w-full" priority={priority} sizes="(min-width: 1024px) 720px, 100vw" />
      {caption ? <figcaption className="border-t border-white/10 px-4 py-2.5 text-xs text-white/55">{caption}</figcaption> : null}
    </figure>
  );
}

export function SectionHeading({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 className="mt-2 text-3xl font-black tracking-tight text-white sm:text-4xl">{title}</h2>
      {children ? <div className="mt-4 text-white/65">{children}</div> : null}
    </div>
  );
}

export function FinalCta() {
  return (
    <section className="border-t border-white/10 bg-gradient-to-b from-[#16171a] to-[#111214]">
      <Container className="flex flex-col items-start justify-between gap-6 py-16 md:flex-row md:items-center">
        <div>
          <h2 className="text-3xl font-black tracking-tight text-white">See it with your own operation in mind.</h2>
          <p className="mt-2 max-w-xl text-white/65">A walkthrough of the live demo company, with fictional data, led by the Taviron team.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <CtaLink href="/demo">Request a demo</CtaLink>
          <CtaLink href="/pricing" variant="ghost">See pricing</CtaLink>
        </div>
      </Container>
    </section>
  );
}
