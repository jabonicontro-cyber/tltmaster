// Light and dark mode for the internal app. The choice is a per-person,
// per-browser display preference (stored in localStorage, never on the
// server). "system" follows the device setting. The public website, documents
// and print always stay light (globals.css).

export type ThemePreference = "light" | "dark" | "system";
export const THEME_KEY = "taviron-theme";
export const THEME_EVENT = "taviron-theme-change";
export const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Match my device" },
];

export function parseTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): "light" | "dark" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref;
}

/**
 * Runs in <head> before the page paints, so a dark-mode user never sees a
 * light flash. Kept tiny and dependency-free; mirrors parseTheme/resolveTheme.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_KEY}");var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"}catch(e){document.documentElement.dataset.theme="light"}})()`;

/** Client only: save the choice and apply it now. */
export function applyTheme(pref: ThemePreference) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // storage blocked (private mode): the choice lasts for this page only
  }
  document.documentElement.dataset.theme = resolveTheme(pref, matchMedia("(prefers-color-scheme: dark)").matches);
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

export function readTheme(): ThemePreference {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}
