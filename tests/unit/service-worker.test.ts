import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// public/sw.js runs in the browser; here it runs against stand-ins for the service worker globals so its promises are
// checked exactly. (Playwright's offline mode does not cover requests a service worker makes, so a browser test cannot
// reliably prove the offline fallback.)

type Handler = (event: Record<string, unknown>) => void;

function load(opts: { network: "up" | "down" }) {
  const handlers: Record<string, Handler> = {};
  const stored = new Map<string, string>();
  const cachesApi = {
    open: async () => ({ addAll: async (urls: string[]) => { for (const u of urls) stored.set(u, `cached ${u}`); } }),
    keys: async () => ["taviron-shell-v0", "taviron-shell-v1"],
    delete: async (k: string) => { stored.delete(k); return true; },
    match: async (u: string) => stored.get(u) ?? undefined,
  };
  const fetched: string[] = [];
  const self = {
    addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self, caches: cachesApi,
    fetch: async (req: { url: string }) => { fetched.push(req.url); if (opts.network === "down") throw new TypeError("offline"); return `network ${req.url}`; },
    Response: { error: () => "network error" },
  });
  const run = async (type: string, event: Record<string, unknown> = {}) => {
    let waited: Promise<unknown> | undefined;
    let responded: Promise<unknown> | undefined;
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => { waited = p; }, respondWith: (p: Promise<unknown>) => { responded = p; } });
    await waited;
    return responded ? await responded : undefined;
  };
  return { run, stored, fetched };
}

describe("companion app service worker", () => {
  it("stores only the offline page and an icon, never company pages", async () => {
    const sw = load({ network: "up" });
    await sw.run("install");
    expect([...sw.stored.keys()].sort()).toEqual(["/app-icons/icon-192.png", "/offline"]);
  });

  it("serves the offline page when a page cannot be loaded", async () => {
    const sw = load({ network: "down" });
    await sw.run("install");
    const r = await sw.run("fetch", { request: { url: "https://x.test/driver", mode: "navigate", method: "GET" } });
    expect(r).toBe("cached /offline");
  });

  it("returns the live page when online and leaves data, actions and assets to the network", async () => {
    const sw = load({ network: "up" });
    await sw.run("install");
    expect(await sw.run("fetch", { request: { url: "https://x.test/driver", mode: "navigate", method: "GET" } })).toBe("network https://x.test/driver");
    // Not handled at all (no respondWith): fetches, server actions and posts go straight to Taviron.
    expect(await sw.run("fetch", { request: { url: "https://x.test/_next/data", mode: "cors", method: "GET" } })).toBeUndefined();
    expect(await sw.run("fetch", { request: { url: "https://x.test/driver", mode: "navigate", method: "POST" } })).toBeUndefined();
    expect(sw.stored.has("https://x.test/driver")).toBe(false);
  });
});
