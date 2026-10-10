// Minimal stand-in for the Supabase API gateway: routes /auth/v1 to Supabase
// Auth (GoTrue), /rest/v1 to PostgREST and (when started) /storage/v1 to
// Supabase Storage, the way supabase-js expects.
// Development / CI only.
import http from "node:http";

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
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `Upstream unavailable: ${err.message}` }));
    });
    req.pipe(upstream);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`dev gateway listening on http://127.0.0.1:${port}`);
  });
