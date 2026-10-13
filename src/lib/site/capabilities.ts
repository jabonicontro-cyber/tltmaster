// What the public website says Taviron does. Derived from the feature catalog (src/lib/site/features.ts,
// docs/MARKETING.md) so there is one source: published features become AVAILABLE, the plain "Not yet" list is PLANNED.
// tests/unit/site-capabilities.test.ts and tests/unit/feature-catalog.test.ts keep both honest. Update the catalog —
// and run through docs/RELEASE_CHECKLIST.md — whenever a release changes what the app can do.
import { NOT_YET, publishedFeatures } from "./features";

export interface Capability {
  title: string;
  points: string[];
  /** App pages (under src/app/(app)) that demonstrate the points. */
  evidence: string[];
}

export const AVAILABLE: Capability[] = publishedFeatures().map((f) => ({ title: f.name, points: f.points, evidence: f.routes }));

export const PLANNED: string[] = NOT_YET;
