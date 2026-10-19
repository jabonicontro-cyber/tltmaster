import { BrandMark, TavironEmblem } from "@/components/layout/brand";

export { TavironEmblem };

/** The Taviron logo on the public website: the shared lockup in the site's light-on-navy tone. */
export function TavironLogo({ className }: { className?: string }) {
  return <BrandMark tone="site" className={className} />;
}
