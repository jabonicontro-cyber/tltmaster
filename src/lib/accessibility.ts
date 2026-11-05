// Accessibility mode (owner 2026-11-05, master plan UX19): larger text, high contrast, reduce motion and an
// easier-to-read font. Saved with the person's account (public.user_accessibility, set_my_accessibility) so it
// follows them to every device; a copy in this browser (localStorage) lets the page apply it before it paints.
// It applies to the app and the customer portal only: the public website (.site) ignores it (globals.css).

export type TextSize = 100 | 115 | 130;
export interface AccessibilitySettings {
  textSize: TextSize;
  highContrast: boolean;
  reduceMotion: boolean;
  readableFont: boolean;
}

export const A11Y_KEY = "taviron-a11y";
export const A11Y_DEFAULTS: AccessibilitySettings = { textSize: 100, highContrast: false, reduceMotion: false, readableFont: false };
export const TEXT_SIZES: Array<{ value: TextSize; label: string }> = [
  { value: 100, label: "Standard" },
  { value: 115, label: "Larger" },
  { value: 130, label: "Largest" },
];

/** Any stored or submitted value, made safe: unknown keys dropped, bad values back to the default. */
export function parseAccessibility(value: unknown): AccessibilitySettings {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const size = Number(v.textSize);
  return {
    textSize: size === 115 || size === 130 ? size : 100,
    highContrast: v.highContrast === true,
    reduceMotion: v.reduceMotion === true,
    readableFont: v.readableFont === true,
  };
}

export function isDefaultAccessibility(s: AccessibilitySettings): boolean {
  return s.textSize === 100 && !s.highContrast && !s.reduceMotion && !s.readableFont;
}

/** The data attributes on <html> that globals.css reads. Absent means off. */
export function accessibilityAttributes(s: AccessibilitySettings): Record<string, string | undefined> {
  return {
    "data-text-size": s.textSize === 100 ? undefined : String(s.textSize),
    "data-contrast": s.highContrast ? "high" : undefined,
    "data-motion": s.reduceMotion ? "reduce" : undefined,
    "data-font": s.readableFont ? "readable" : undefined,
  };
}

/**
 * Runs before the page paints (like THEME_SCRIPT): applies this browser's copy, so a person with larger text never
 * sees the page jump. Mirrors parseAccessibility/accessibilityAttributes; kept tiny and dependency-free.
 */
export const A11Y_SCRIPT = `(function(){try{var s=JSON.parse(localStorage.getItem("${A11Y_KEY}")||"{}"),d=document.documentElement.dataset;if(s.textSize===115||s.textSize===130)d.textSize=String(s.textSize);if(s.highContrast===true)d.contrast="high";if(s.reduceMotion===true)d.motion="reduce";if(s.readableFont===true)d.font="readable"}catch(e){}})()`;

/** Client only: keep this browser's copy and apply the settings now. */
export function applyAccessibility(s: AccessibilitySettings) {
  try {
    if (isDefaultAccessibility(s)) localStorage.removeItem(A11Y_KEY);
    else localStorage.setItem(A11Y_KEY, JSON.stringify(s));
  } catch {
    // storage blocked (private mode): the account still holds the settings; they apply when the app loads
  }
  const el = document.documentElement;
  for (const [name, value] of Object.entries(accessibilityAttributes(s))) {
    if (value === undefined) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }
}
