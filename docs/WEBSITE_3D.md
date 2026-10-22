> **Retired 2026-10-19:** the homepage now opens with a static hero and the real product (`ProductShowcase`, screens
> from the demo company); the scroll-driven 3D truck (`truck-story.tsx`, `truck-scene.tsx`) and its test were removed
> (owner request: reliable on every screen, nothing drawn that the product does not do). Kept below for history.
> Test: `tests/e2e/home-hero.spec.ts`.
> The `three` and `@types/three` dependencies were removed on 2026-10-22 (nothing imported them).

# Homepage 3D story

The homepage hero is a real-time WebGL truck (`src/components/site/truck-scene.tsx`) that follows the story text
(`src/components/site/truck-story.tsx`, chapters in `src/app/(site)/page.tsx`).

- **Truck model:** procedural geometry written in code, with no third-party model or texture, so there is no licence
  to track.
- **three.js:** MIT licence, version 0.186.1. It loads only after the page is idle and is not in the initial HTML.

## Storyboard (2026-10-13)

There is one scene per story step. The truck stays the subject of every scene; what changes around it illustrates the
text beside it.

| Step | Message | Truck | Camera | Around it | Into the next |
| --- | --- | --- | --- | --- | --- |
| 0 Intro | A smarter way to run a fleet | Parked | Front three-quarter, whole rig | Road, shadow | Pulls up and back |
| 1 The whole operation | Every load, truck and driver planned together | Parked in the yard | Wide, high three-quarter | Two more trucks drive into the yard; lines draw from each truck to the day's load pins | Fleet drives off |
| 2 Profitability | Revenue in view, honestly estimated | Drives on (wheels turn, road moves) | Profile, following | Open road | Slows onto a pad |
| 3 Reliability | Every rule checked before anything is proposed | Stops on an inspection pad | Low rear three-quarter | Pad outlined in light, gate frame ahead | Rises overhead |
| 4 Fleet utilization | Compare plans, not guesses | Parked with the fleet | High, top-down | Two ways to assign the same loads: one bright, one dim | Moves to the job site |
| 5 Less paperwork | The office work follows the truck (verified deliveries) | Body tips up, tailgate swings, gravel pours | Wide side view | Pile grows on the ground | — |

## Honesty rules

- The lines in steps 1 and 4 connect trucks to loads (assignments). They are **not** road routes: Taviron does not
  calculate routes or distances, and the scene must not suggest it does.
- No scene shows a capability that is not in `src/lib/site/capabilities.ts` (AVAILABLE).

## Timing and sync

- Each step's centre is measured against the reading line: the middle of the screen, or below the pinned truck on
  phones.
- A scene holds while its text is being read and changes only between steps (30–70 % of the way to the next step).
  This replaces the earlier linear mapping over the whole section, which drifted because the intro and the chapters
  have different heights.
- Rendering runs only while something changes, so the GPU idles when the page is still.
- `data-scene` on `.truck-story` (scroll position) and `data-shown` on the scene host (what is drawn) expose the state
  for tests.

## Screens

- **Desktop:** the scene spans the section behind the text and is framed to the right.
- **Tablet in portrait at 1024 px (side-by-side layout on a tall screen):** the truck is drawn smaller
  (`zoom 0.6`) and further right so it never covers the text.
- **Phones and narrower tablets:** the truck is pinned at the top and the text scrolls beneath it. The truck sits
  above the text layer (`z-20`); before 2026-10-13 the text painted over it.
- **Reduced motion:** one still pose (`data-mode="3d-still"`); scrolling does not move it.
- **No WebGL:** the static illustration (`DumpTruck`) stays, and the story reads the same.

## Tests

`tests/e2e/home-story.spec.ts` covers:

- the scene following every step at desktop, tablet-portrait and phone sizes;
- no sideways scrolling and no console errors;
- the reduced-motion still pose;
- the no-WebGL fallback.

Visual review: screenshots of every step at 1440 px, 1024 × 1366, 820 px and 390 px (2026-10-13, local).
