/**
 * Shared page containers: one content edge per surface, so headers, tabs and page content line up at every width.
 * App = company workspaces and the platform console (wide tables); site = the public website and early-access pages.
 * Use these instead of writing max-width and padding by hand (the drift they replace: px-3/px-6 headers over
 * px-4/sm:px-6/lg:px-8 pages, and sm:px-8 on some site pages against sm:px-6 elsewhere).
 */
export const APP_CONTAINER = "mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8";
export const SITE_CONTAINER = "mx-auto w-full max-w-6xl px-4 sm:px-6";
