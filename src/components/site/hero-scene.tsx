/* eslint-disable @next/next/no-img-element -- decorative layers inside a 3D transform; the same screenshots appear below with next/image and alt text */
/**
 * The site's signature element: three real screens of the app (Command
 * Center, dispatch board, driver phone — fictional demo data) stacked in 3D
 * with a dispatch route drawn across them. Pure CSS; still when the visitor
 * prefers reduced motion. Decorative: hidden from assistive technology.
 */
export function HeroScene() {
  return (
    <div className="site-scene relative mx-auto h-[300px] w-full max-w-[560px] sm:h-[420px]" aria-hidden>
      <div className="site-stack site-float absolute top-[8%] left-[14%] h-[78%] w-[72%]">
        <div className="site-layer site-layer-1 top-0 left-0 w-full">
          <img src="/site/command-center.png" alt="" loading="eager" />
        </div>
        <div className="site-layer site-layer-2 top-[18%] left-[16%] w-[86%]">
          <img src="/site/dispatch.png" alt="" loading="eager" />
        </div>
        <div className="site-layer site-layer-3 top-[30%] left-[68%] w-[30%] rounded-[18px]">
          <img src="/site/driver.png" alt="" loading="eager" />
        </div>
        <svg className="site-route" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M12 74 C 26 66, 38 56, 52 58 S 72 50, 80 44" fill="none" stroke="#ed1c24" strokeWidth="0.9" strokeLinecap="round" />
          <circle cx="12" cy="74" r="1.6" fill="#ed1c24" />
          <circle cx="80" cy="44" r="1.6" fill="#fff" />
        </svg>
      </div>
      <div className="absolute inset-x-[10%] bottom-0 h-16 rounded-[100%] bg-brand/25 blur-3xl" />
    </div>
  );
}
