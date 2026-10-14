import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// Shared building blocks of the public website (Taviron palette: navy, silver,
// electric blue accents, action blue for filled buttons — see globals.css).

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>;
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-[13px] font-semibold tracking-[0.14em] text-electric uppercase", className)}>{children}</p>;
}

export function PageIntro({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <section className="relative overflow-hidden border-b border-silver/10">
      <div className="site-grid-bg pointer-events-none absolute inset-0" aria-hidden />
      <Container className="relative py-16 sm:py-20">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="site-display mt-3 max-w-3xl text-4xl font-bold text-cloud sm:text-5xl">{title}</h1>
        {children ? <div className="mt-5 max-w-2xl text-lg leading-relaxed text-silver">{children}</div> : null}
      </Container>
    </section>
  );
}

export function CtaLink({ href, children, variant = "primary", className }: { href: string; children: ReactNode; variant?: "primary" | "ghost"; className?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "site-press inline-flex h-11 items-center justify-center gap-2 rounded-md px-5 text-[15px] font-semibold",
        variant === "primary" ? "bg-action text-white hover:bg-action-hover" : "border border-silver/25 text-cloud hover:border-silver/50 hover:bg-white/[0.04]",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** A real screenshot of the app (fictional demo data), framed like a window. */
export function Screenshot({ src, alt, width, height, caption, className, priority }: { src: string; alt: string; width: number; height: number; caption?: string; className?: string; priority?: boolean }) {
  return (
    <figure className={cn("overflow-hidden rounded-xl border border-silver/15 bg-navy-2 shadow-[0_30px_80px_-30px_rgb(0_0_0/0.7)]", className)}>
      <div className="flex items-center gap-1.5 border-b border-silver/10 px-3.5 py-2.5" aria-hidden>
        <span className="size-2.5 rounded-full bg-silver/20" />
        <span className="size-2.5 rounded-full bg-silver/20" />
        <span className="size-2.5 rounded-full bg-silver/20" />
      </div>
      <Image src={src} alt={alt} width={width} height={height} className="h-auto w-full" priority={priority} sizes="(min-width: 1152px) 1104px, 100vw" />
      {caption ? <figcaption className="border-t border-silver/10 px-4 py-2.5 text-xs text-silver/75">{caption}</figcaption> : null}
    </figure>
  );
}

export function SectionHeading({ eyebrow, title, children, className, id }: { eyebrow?: string; title: string; children?: ReactNode; className?: string; /** The heading's id, for aria-labelledby. */ id?: string }) {
  return (
    <div className={cn("max-w-2xl", className)}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h2 id={id} className="site-title mt-3 text-3xl font-bold text-cloud sm:text-[2.5rem]">{title}</h2>
      {children ? <div className="mt-4 text-[17px] leading-relaxed text-silver">{children}</div> : null}
    </div>
  );
}

export function FinalCta() {
  return (
    <section className="border-t border-silver/10 bg-navy-2">
      <Container className="flex flex-col items-start justify-between gap-6 py-16 md:flex-row md:items-center">
        <div>
          <h2 className="site-title text-3xl font-bold text-cloud">See it with your own operation in mind.</h2>
          <p className="mt-2 max-w-xl text-silver">A free walkthrough of the live demo company, with fictional data, led by the Taviron team.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <CtaLink href="/demo">Request a demo</CtaLink>
          <CtaLink href="/pricing" variant="ghost">See pricing</CtaLink>
        </div>
      </Container>
    </section>
  );
}
