import { cn } from "@/lib/cn";
import { PUBLIC_WEBSITE_URL } from "@/lib/site/urls";
import { TavironEmblem } from "./brand";

/**
 * The "Powered by Taviron" line at the foot of every company workspace sidebar (desktop and phone menu). An ordinary
 * link to the public homepage, same tab, so Back returns to the workspace. It never changes the company or session.
 * `labelHidden` fades the words while the desktop sidebar is collapsed; the link keeps its accessible name.
 */
export function PoweredByTaviron({ labelHidden = false, className }: { labelHidden?: boolean; className?: string }) {
  return (
    <a
      href={`${PUBLIC_WEBSITE_URL}/`}
      aria-label="Powered by Taviron — visit the Taviron website"
      className={cn(
        "group flex min-h-9 items-center gap-2 rounded-xl text-xs whitespace-nowrap text-nav-fg/55 transition-colors duration-150 hover:bg-nav-fg/[0.06] hover:text-nav-fg/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nav-fg/60 motion-reduce:transition-none",
        className,
      )}
    >
      <TavironEmblem className="size-[18px] opacity-80 transition-opacity group-hover:opacity-100" />
      <span className={cn("transition-opacity duration-150 motion-reduce:transition-none", labelHidden && "opacity-0")}>Powered by Taviron</span>
    </a>
  );
}
