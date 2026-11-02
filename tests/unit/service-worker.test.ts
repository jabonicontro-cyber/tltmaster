import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// public/sw.js runs in the browser; here it runs against stand-ins for the service worker globals so its promises are
// checked exactly. (Playwright's offline mode does not cover requests a service worker makes, so a browser test cannot
// reliably prove the offline fallback.)

type Handler = (event: Record<string, unknown>) => void;
const OFFLINE_HTML = '<html><script src="/_next/static/chunks/app/offline/page-abc.js"></script><link href="/_next/static/css/app-1.css"></html>';

function load(opts: { network: "up" | "down" }) {
  const handlers: Record<string, Handler> = {};
  const stored = new Map<string, string>();
  const res = (url: string) => ({ ok: true, url, text: async () => (url === "/offline" ? OFFLINE_HTML : `body ${url}`), clone() { return this; }, toString: () => `network ${url}` });
  const cache = {
    addAll: async (urls: string[]) => { for (const u of urls) stored.set(u, `cached ${u}`); },
    put: async (u: string) => { stored.set(u, `cached ${u}`); },
  };
  const cachesApi = {
    open: async () => cache,
    keys: async () => ["taviron-shell-v1", "taviron-shell-v2"],
    delete: async () => true,
    match: async (u: string) => stored.get(u) ?? undefined,
  };
  const fetched: string[] = [];
  const self = {
    addEventListener: (type: string, fn: Handler) => { handlers[type] = fn; },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self, caches: cachesApi, Set,
    fetch: async (req: string | { url: string }) => {
      const url = typeof req === "string" ? req : req.url;
      fetched.push(url);
      if (opts.network === "down") throw new TypeError("offline");
      return res(url);
    },
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
  it("stores the offline page, an icon and the offline page's own build files — never company pages or data", async () => {
    const sw = load({ network: "up" });
    await sw.run("install");
    expect([...sw.stored.keys()].sort()).toEqual(["/_next/static/chunks/app/offline/page-abc.js", "/_next/static/css/app-1.css", "/app-icons/icon-192.png", "/offline"]);
  });

  it("serves the offline page when a page cannot be loaded, and kept build files without signal", async () => {
    const sw = load({ network: "down" });
    await sw.run("install"); // nothing could be fetched: the shell is stored, no build files
    expect(await sw.run("fetch", { request: { url: "https://x.test/driver", mode: "navigate", method: "GET" } })).toBe("cached /offline");
    sw.stored.set("https://x.test/_next/static/chunks/a.js", "cached a");
    expect(await sw.run("fetch", { request: { url: "https://x.test/_next/static/chunks/a.js", mode: "no-cors", method: "GET" } })).toBe("cached a");
  });

  it("returns the live page when online and leaves data, actions and other assets to the network", async () => {
    const sw = load({ network: "up" });
    await sw.run("install");
    expect(String(await sw.run("fetch", { request: { url: "https://x.test/driver", mode: "navigate", method: "GET" } }))).toBe("network https://x.test/driver");
    // Not handled at all (no respondWith): fetches, server actions and posts go straight to Taviron.
    expect(await sw.run("fetch", { request: { url: "https://x.test/_next/data", mode: "cors", method: "GET" } })).toBeUndefined();
    expect(await sw.run("fetch", { request: { url: "https://x.test/driver", mode: "navigate", method: "POST" } })).toBeUndefined();
    expect(await sw.run("fetch", { request: { url: "https://x.test/api/anything", mode: "cors", method: "GET" } })).toBeUndefined();
    expect(sw.stored.has("https://x.test/driver")).toBe(false);
  });

  it("keeps a build file the first time it is loaded", async () => {
    const sw = load({ network: "up" });
    const r = await sw.run("fetch", { request: { url: "https://x.test/_next/static/chunks/b.js", mode: "no-cors", method: "GET" } });
    expect(String(r)).toBe("network https://x.test/_next/static/chunks/b.js");
    await new Promise((r) => setTimeout(r, 0));
    expect(sw.stored.has("https://x.test/_next/static/chunks/b.js")).toBe(true);
  });
});
