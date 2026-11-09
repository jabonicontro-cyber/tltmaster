import Image from "next/image";
import { screenshotById } from "@/lib/site/features";
import { delay } from "./ui";

/**
 * The homepage hero visual (redesign 2026-10-25, owner's references: Highnote, Squarespace): the real Command Center
 * (fictional demo data) as a floating card that reaches toward the right edge of the page, with the driver's phone
 * hanging below its lower right corner. Recomposed 2026-11-09 (owner: the old card was cut off at the right and the
 * phone covered the summary tiles): the card stops short of the window edge so the whole screen shows, and the phone
 * sits over the lower right, below the tiles. Product, not a scene: no truck illustration, no 3D. On phones it is
 * the screenshot card alone, full width.
 */
export function ProductShowcase() {
  const cc = screenshotById("command-center")!;
  const driver = screenshotById("driver")!;
  return (
    // Opens with the screen rising into place, then drifts up as the page scrolls; the phone arrives last and moves a
    // little faster, so the two read as layers.
    <div className="site-parallax relative mt-14 lg:mt-0">
      {/* The card reaches past the container on large screens (to 2rem from the window edge), so the product reads as a
          window into the app without any of it being cut off. */}
      <figure style={delay(120)} className="site-enter-img relative overflow-hidden rounded-[1.75rem] bg-white shadow-[0_40px_90px_-30px_rgb(12_26_43/0.45)] ring-1 ring-[#0c1a2b]/[0.06] lg:mr-[calc(0.5rem-max(0px,(100vw-72rem)/2))] lg:max-h-[34rem]">
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
      <figure className="site-parallax-fast absolute -bottom-36 right-4 hidden w-[24%] max-w-[9.5rem] lg:block">
        <div style={delay(380)} className="site-enter-img overflow-hidden rounded-[28px] border-[6px] border-[#0c1a2b] bg-black shadow-[0_30px_60px_-20px_rgb(12_26_43/0.55)]">
          <Image src={`/site/${driver.file}`} alt={driver.alt} width={780} height={1688} className="h-auto w-full" sizes="210px" />
        </div>
        <figcaption className="sr-only">{driver.caption}</figcaption>
      </figure>
      <p className="mt-4 text-sm text-silver lg:hidden">{cc.caption}</p>
    </div>
  );
}
