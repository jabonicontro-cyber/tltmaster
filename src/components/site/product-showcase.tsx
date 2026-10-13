import Image from "next/image";
import { screenshotById } from "@/lib/site/features";
import { DumpTruck } from "./dump-truck";
import { Screenshot } from "./ui";

/**
 * The homepage product showcase: the real Command Center (fictional demo data)
 * at the centre, the driver's phone in front, and an original dump-truck
 * illustration on a lit road behind — layered with CSS perspective, no 3D
 * library and no ongoing motion. On small screens it flattens to the screenshot.
 */
export function ProductShowcase() {
  const cc = screenshotById("command-center")!;
  const driver = screenshotById("driver")!;
  return (
    <div className="showcase relative mt-14 sm:mt-16">
      <div className="showcase-glow pointer-events-none absolute inset-x-[-10%] -top-16 bottom-0 hidden md:block" aria-hidden />
      <div className="showcase-road pointer-events-none absolute inset-x-[-12%] bottom-[-14%] hidden h-[38%] md:block" aria-hidden />
      <DumpTruck className="showcase-truck pointer-events-none absolute bottom-[-17%] left-[-1%] z-0 hidden w-[46%] md:block xl:left-[-9%] xl:w-[50%]" />

      <div className="showcase-stage relative">
        <div className="showcase-screen relative z-10 md:mx-auto md:w-[84%]">
          <Screenshot
            src={`/site/${cc.file}`}
            alt={cc.alt}
            width={2880}
            height={1800}
            caption={cc.caption}
            priority
          />
        </div>
        <figure className="showcase-phone absolute right-[1%] bottom-[-10%] z-20 hidden w-[19%] md:block">
          <div className="overflow-hidden rounded-[26px] border-[5px] border-[#1d2b3d] bg-black shadow-[0_40px_80px_-24px_rgb(0_0_0/0.8)] ring-1 ring-silver/25">
            <Image src={`/site/${driver.file}`} alt={driver.alt} width={780} height={1688} className="h-auto w-full" sizes="(min-width: 1024px) 220px, 20vw" />
          </div>
          <figcaption className="sr-only">{driver.caption}</figcaption>
        </figure>
      </div>
    </div>
  );
}
