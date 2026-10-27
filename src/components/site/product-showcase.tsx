import Image from "next/image";
import { screenshotById } from "@/lib/site/features";
import { delay } from "./ui";

/**
 * The homepage hero visual (redesign 2026-10-25, owner's references: Highnote, Squarespace): the real Command Center
 * (fictional demo data) as a floating card that runs off the right edge of the page, with the driver's phone
 * overlapping its lower left corner. Product, not a scene: no truck illustration, no 3D. On phones it is the
 * screenshot card alone, full width.
 */
export function ProductShowcase() {
  const cc = screenshotById("command-center")!;
  const driver = screenshotById("driver")!;
  return (
    // Opens with the screen rising into place, then drifts up as the page scrolls; the phone arrives last and moves a
    // little faster, so the two read as layers.
    <div className="site-parallax relative mt-14 lg:mt-0">
      {/* The card bleeds past the container on large screens, so the product reads as a window into the app. */}
      <figure style={delay(120)} className="site-enter-img relative overflow-hidden rounded-[1.75rem] bg-white shadow-[0_40px_90px_-30px_rgb(12_26_43/0.45)] ring-1 ring-[#0c1a2b]/[0.06] lg:mr-[-18vw] lg:max-h-[34rem]">
        <Image
          src={`/site/${cc.file}`}
          alt={cc.alt}
          width={2880}
          height={1800}
          priority
          sizes="(min-width: 1024px) 60vw, 100vw"
          className="h-auto w-full object-cover object-left-top"
        />
        <figcaption className="sr-only">{cc.caption}</figcaption>
      </figure>
      <figure className="site-parallax-fast absolute -bottom-10 -left-6 hidden w-[30%] max-w-[13rem] lg:block">
        <div style={delay(380)} className="site-enter-img overflow-hidden rounded-[28px] border-[6px] border-[#0c1a2b] bg-black shadow-[0_30px_60px_-20px_rgb(12_26_43/0.55)]">
          <Image src={`/site/${driver.file}`} alt={driver.alt} width={780} height={1688} className="h-auto w-full" sizes="210px" />
        </div>
        <figcaption className="sr-only">{driver.caption}</figcaption>
      </figure>
      <p className="mt-4 text-sm text-silver lg:hidden">{cc.caption}</p>
    </div>
  );
}
