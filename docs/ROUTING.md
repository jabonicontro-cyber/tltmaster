# Route Planner and truck routing

Route Planner (`/route-planner`, permission `dispatch.view`) shows each truck's day as a route: from the yard to every
delivery site in load order (the dispatch board's start times) and back. It is read-only: routes change only when the
board does. Backlog row B10, first slice (owner 2026-10-14; HERE chosen as the first provider).

## 1. What it shows

- One card per truck: driver, trailer, loads, and every leg with its distance.
- **Without a routing provider** (the default): straight-line distances, labelled "straight line (estimate)". They are
  the shortest possible distance; trucks drive further.
- **With HERE connected:** road miles, driving time and HERE's own notices for each leg (for example a restriction on
  the route), using HERE's standard truck profile. Truck dimensions are not recorded in Taviron yet. A route without
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
| Database | `supabase/migrations/20261112000500_routing.sql` (yard columns; site location source) |
| Demo sample locations | `src/server/demo/locations.ts` |
| Tests | `tests/unit/routing.test.ts` (no live calls), `tests/e2e/route-planner.spec.ts`, demo parity |

## 3. Limits and privacy

- Only coordinates (routing) or the site's address text (geocoding) are sent to HERE; never names, customers or ids.
- Nothing from HERE is stored in the database. Answers are cached in server memory for six hours.
- A page asks HERE for at most 40 new legs; the rest say "Not routed" and route when one truck is selected.
- The key is a server-only environment variable; it is never logged, shown or put in an error message.
- Demo companies stay on straight lines unless `ROUTING_IN_DEMOS=on` (DEMO_TENANTS §2).

## 4. Owner steps to turn on truck routing

1. **Apply the migration** `20261112000500_routing.sql` with `npx supabase db push` (DEPLOYMENT §2a). Without it the
   page works, but the yard cannot be saved and site locations are not marked as manual or estimated.
2. **Create a HERE account** (developer portal), a project and a REST **API key**. Check HERE's current free-tier
   limits and pricing yourself; set any usage alerts HERE offers.
3. **Add to Vercel** (Production and Preview): `ROUTING_PROVIDER=here`, `HERE_API_KEY=<the key>`. Optional:
   `ROUTING_IN_DEMOS=on` (demos call HERE too), `ROUTING_TIMEOUT_MS` (default 8000).
4. **Redeploy**, open Route Planner, and check one route shows "Road, by HERE".
