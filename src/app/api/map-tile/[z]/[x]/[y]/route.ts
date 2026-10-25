import { assertPermission } from "@/server/auth";
import { RoutingError } from "@/server/routing/here";
import { routingStatus } from "@/server/routing/service";

// Map tiles for the Route Planner (B10), fetched from the routing provider on the server so its key never reaches the
// browser. Signed-in people with dispatch.view only; zoom 3–17 only; nothing is stored by Taviron (the browser may
// keep a tile for a day). Without a configured provider, or in a demo company with routing off, there are no tiles.

export async function GET(_req: Request, ctx: { params: Promise<{ z: string; x: string; y: string }> }) {
  let access;
  try {
    access = await assertPermission("dispatch.view");
  } catch {
    return new Response("Not permitted.", { status: 403 });
  }
  const { z, x, y } = await ctx.params;
  const [zi, xi, yi] = [z, x, y].map((v) => (/^\d{1,6}$/.test(v) ? Number(v) : NaN));
  if (!(zi >= 3 && zi <= 17) || !(xi >= 0 && xi < 2 ** zi) || !(yi >= 0 && yi < 2 ** zi)) return new Response("Invalid tile.", { status: 400 });
  const status = routingStatus(access);
  if (status.state !== "ready") return new Response("Map tiles are not available.", { status: 404 });
  try {
    const png = await status.provider.tile(zi, xi, yi);
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" } });
  } catch (e) {
    const kind = e instanceof RoutingError ? e.kind : "provider";
    return new Response("Map tile unavailable.", { status: kind === "rate_limit" ? 429 : 502 });
  }
}
