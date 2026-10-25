# Route Planner and truck routing

Route Planner (`/route-planner`, permission `dispatch.view`) has three views (backlog B10; HERE chosen as the first
provider, owner 2026-10-14; core slice DIR-1, 2026-10-25):

- **Today's routes:** each truck's day as a route, from the yard to every delivery site in load order and back.
  Read-only: routes change only when the dispatch board does.
- **Plan a route:** up to 25 places (saved locations, customer sites or typed coordinates; with HERE, an address
  search that shows every match for a person to pick), a truck (its recorded dimensions go to HERE), minutes at each
  stop, return to start, alternatives for two places, **Suggest a shorter order** (straight-line nearest neighbour +
  2-opt, first stop fixed; a suggestion only) and saved routes. Planning never assigns a load.
- **Locations:** yards, terminals, quarries, plants and other pickups (`company_locations`); customer job sites stay
  with the customer. A yard can be made the start of every daily route.

## 1. What it shows

- One card per truck: driver, trailer, loads, and every leg with its distance.
- **Without a routing provider** (the default): straight-line distances, labelled "straight line (estimate)". They are
  the shortest possible distance; trucks drive further.
- **With HERE connected:** road miles, driving time and HERE's own notices for each leg (for example a restriction on
  the route), using the truck's recorded height, width, length, gross weight and axles (Fleet → truck → Edit, entered in feet and
pounds, stored in cm and kg), or HERE's standard truck when none are recorded. A route without
  notices is not a guarantee that the road is clear: closures, frost laws and seasonal limits are not covered.
- **Sites without a location** are listed at the top. Anyone with `customers.edit` can type coordinates (from any map),
  or, with HERE connected, click **Find from address**. A geocoded location is an estimate of the address and is
  labelled as such on the route.
- **Yard location** (start and end of every route) is set by someone with `settings.manage`, on the page or by
  typing coordinates. With HERE connected, **Use the company address** looks it up.

## 2. Code

| Part | File |
| --- | --- |
| Route building, straight lines, totals (pure) | `src/lib/routing/route.ts` |
| HERE adapter (truck routing, geocoding) | `src/server/routing/here.ts` |
| Configuration, demo switch, cache and call cap | `src/server/routing/service.ts` |
| Day data (assignments, sites, yard) | `src/server/data/routes.ts` |
| Page and actions | `src/app/(app)/route-planner/` |
| Route builder (plan, save, locations) | `src/app/(app)/route-planner/builder-actions.ts`, `src/components/routing/` |
| Order suggestion, flexible polyline, dimensions | `src/lib/routing/optimize.ts`, `flexpolyline.ts`, `dimensions.ts` |
| Map tiles (HERE, through the server; `dispatch.view`) | `src/app/api/map-tile/[z]/[x]/[y]/route.ts` |
| Database | `20261112000500_routing.sql` (yard, site location source); `20261120002600_route_planner_core.sql` (locations, truck dimensions, saved routes); `20261120002700_yard_location_grant.sql` (the yard could not be saved before it) |
| Demo samples | `src/server/demo/locations.ts` (yard, sites); `routePlanner` in `src/server/demo/samples.ts` (fictional pits and plant, two trucks' dimensions, one saved route, up to three of today's loads assigned through `assign_load`) |
| Tests | `tests/unit/routing.test.ts` (no live calls), `tests/db/route-planner.test.ts`, `tests/db/demo-samples.test.ts`, `tests/e2e/route-planner.spec.ts`, demo parity |

## 3. Limits and privacy

- Only coordinates (routing) or the site's address text (geocoding) are sent to HERE; never names, customers or ids.
- Nothing from HERE is stored in the database. Answers are cached in server memory for six hours.
- A page asks HERE for at most 40 new legs; the rest say "Not routed" and route when one truck is selected.
- The key is a server-only environment variable; it is never logged, shown or put in an error message.
- Demo companies stay on straight lines unless `ROUTING_IN_DEMOS=on` (DEMO_TENANTS §2).

## 4. Owner steps to turn on truck routing

1. **Migrations** `20261120002600` and `20261120002700` are applied by the DB migrate workflow when the Production
   branch is promoted (DEPLOYMENT §2c). Without them the page works, but saved locations, routes and truck dimensions
   say "not installed" and the yard cannot be saved.
2. **Create a HERE account** (developer portal), a project and a REST **API key**. Check HERE's current free-tier
   limits and pricing yourself; set any usage alerts HERE offers.
3. **Add to Vercel** (Production and Preview): `ROUTING_PROVIDER=here`, `HERE_API_KEY=<the key>`. Optional:
   `ROUTING_IN_DEMOS=on` (demos call HERE too), `ROUTING_TIMEOUT_MS` (default 8000).
4. **Redeploy**, open Route Planner, and check one route shows "Road, by HERE".
5. **Demos:** Refresh each demo (Admin → Demo) so it gets the yard, locations, a saved route and today's routes.
