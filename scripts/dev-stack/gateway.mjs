// Minimal stand-in for the Supabase API gateway: routes /auth/v1 to Supabase
// Auth (GoTrue), /rest/v1 to PostgREST and (when started) /storage/v1 to
// Supabase Storage, the way supabase-js expects.
// Development / CI only.
import fs from "node:fs";
import http from "node:http";
import nodePath from "node:path";

const port = Number(process.env.GATEWAY_PORT ?? 54321);
const authPort = Number(process.env.AUTH_PORT ?? 9999);
const restPort = Number(process.env.REST_PORT ?? 54330);
const storagePort = Number(process.env.STORAGE_PORT ?? 5000);

const routes = [
  { prefix: "/auth/v1", port: authPort },
  { prefix: "/rest/v1", port: restPort },
  { prefix: "/storage/v1", port: storagePort },
];

http
  .createServer((req, res) => {
    // Email templates for the local Auth server (it loads templates by URL).
    const tpl = req.url.match(/^\/dev-templates\/([a-z]+)\.html$/);
    if (tpl) {
      const file = nodePath.join(new URL("../../supabase/templates", import.meta.url).pathname, `${tpl[1]}.html`);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(file));
      return;
    }
    const route = routes.find((r) => req.url === r.prefix || req.url.startsWith(r.prefix + "/") || req.url.startsWith(r.prefix + "?"));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not found" }));
      return;
    }
    const path = req.url.slice(route.prefix.length) || "/";
    const upstream = http.request(
      { host: "127.0.0.1", port: route.port, path, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      // The upstream may fail after its response started (e.g. Storage closing
      // the connection on an oversized upload): cut this response, keep serving.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `Upstream unavailable: ${err.message}` }));
    });
    req.pipe(upstream);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`dev gateway listening on http://127.0.0.1:${port}`);
  });
