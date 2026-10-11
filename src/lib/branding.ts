// Company branding in the internal app (N15): each company's own logo and
// colors, stored in its company_settings row (row-level security keeps it to
// that company). Companies without branding see the default Taviron look.
// The public website keeps its own charcoal/red identity and never uses these.

export interface Branding {
  logo: string; // data:image/(png|jpeg|webp);base64,… or ""
  color: string; // "#rrggbb" or "" — buttons, links, highlights
  sidebarColor: string; // "#rrggbb" or "" — the navigation background
}

export const EMPTY_BRANDING: Branding = { logo: "", color: "", sidebarColor: "" };
export const MAX_LOGO_BYTES = 250_000;
const HEX = /^#[0-9a-f]{6}$/i;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
/** WCAG contrast ratio between two colors. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * Problems with a color choice, or [] when it is usable. White text sits on
 * both colors (buttons, navigation), so each must keep white text readable:
 * 4.5:1 for the accent (WCAG AA) and 7:1 for the navigation background.
 */
export function brandingProblems(b: Pick<Branding, "color" | "sidebarColor">): Record<string, string> {
  const out: Record<string, string> = {};
  if (b.color) {
    if (!HEX.test(b.color)) out.brand_color = "Use a color like #1F6FEB.";
    else if (contrast(b.color, "#ffffff") < 4.5) out.brand_color = "Too light: white text on it would be hard to read. Choose a darker shade.";
  }
  if (b.sidebarColor) {
    if (!HEX.test(b.sidebarColor)) out.brand_sidebar_color = "Use a color like #102030.";
    else if (contrast(b.sidebarColor, "#ffffff") < 7) out.brand_sidebar_color = "Too light for the navigation: white text on it would be hard to read. Choose a darker shade.";
  }
  return out;
}

const mix = (hex: string, target: number, amount: number) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(c + (target - c) * amount);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, "0")).join("")}`;
};

/** CSS custom properties that re-theme the app shell for one company. Empty when unbranded. */
export function brandingStyle(b: Branding): Record<string, string> {
  const style: Record<string, string> = {};
  if (b.color && HEX.test(b.color)) {
    style["--color-brand"] = b.color;
    style["--color-brand-dark"] = mix(b.color, 0, 0.15);
    style["--color-brand-light"] = mix(b.color, 255, 0.9);
  }
  if (b.sidebarColor && HEX.test(b.sidebarColor)) {
    style["--color-charcoal"] = b.sidebarColor;
    style["--color-charcoal-2"] = mix(b.sidebarColor, 255, 0.08);
    style["--color-charcoal-3"] = mix(b.sidebarColor, 255, 0.16);
  }
  return style;
}

/** The image type from the file's first bytes (not its name or declared type). */
export function sniffImage(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  return null;
}
