import type { Point } from "@/lib/routing/route";

// A fitted map of a route (B10): numbered stops, the road line when the provider returned one, and map tiles from the
// routing provider through Taviron's server (/api/map-tile; the key never reaches the browser). Without tiles it draws
// the same stops on a plain grid and says so. No interaction and no third-party script: it renders on the server too.

const W = 640;
const H = 360;
const PAD = 48;
const TILE = 256;

const worldX = (lng: number, z: number) => ((lng + 180) / 360) * TILE * 2 ** z;
function worldY(lat: number, z: number) {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
}

export interface MapStop {
  point: Point;
  label: string;
}

/** The largest zoom (3–16) at which every point fits inside the frame. */
export function fitZoom(points: Point[]): number {
  for (let z = 16; z > 3; z--) {
    const xs = points.map((p) => worldX(p.lng, z));
    const ys = points.map((p) => worldY(p.lat, z));
    if (Math.max(...xs) - Math.min(...xs) <= W - 2 * PAD && Math.max(...ys) - Math.min(...ys) <= H - 2 * PAD) return z;
  }
  return 3;
}

function sample(line: Point[], max = 600): Point[] {
  if (line.length <= max) return line;
  const step = Math.ceil(line.length / max);
  return line.filter((_, i) => i % step === 0 || i === line.length - 1);
}

/** connect: false for a set of separate places (saved locations, address matches), which are not a route. */
export function RouteMap({ stops, line = [], tiles, title, connect = true }: { stops: MapStop[]; line?: Point[]; tiles: boolean; title: string; connect?: boolean }) {
  const all = [...stops.map((s) => s.point), ...line];
  if (!all.length) return null;
  const z = fitZoom(all);
  const xs = all.map((p) => worldX(p.lng, z));
  const ys = all.map((p) => worldY(p.lat, z));
  const ox = (Math.min(...xs) + Math.max(...xs)) / 2 - W / 2;
  const oy = (Math.min(...ys) + Math.max(...ys)) / 2 - H / 2;
  const px = (p: Point) => [worldX(p.lng, z) - ox, worldY(p.lat, z) - oy] as const;
  const tileImgs: Array<{ key: string; src: string; left: number; top: number }> = [];
  if (tiles) {
    const max = 2 ** z;
    for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + W) / TILE); tx++) {
      for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + H) / TILE); ty++) {
        if (ty < 0 || ty >= max) continue;
        const wx = ((tx % max) + max) % max;
        tileImgs.push({ key: `${tx}-${ty}`, src: `/api/map-tile/${z}/${wx}/${ty}`, left: tx * TILE - ox, top: ty * TILE - oy });
      }
    }
  }
  const linePts = sample(line).map((p) => px(p).join(",")).join(" ");
  return (
    <figure className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
        {tileImgs.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element -- map tiles from our own tile proxy, positioned by hand
          <img key={t.key} src={t.src} alt="" aria-hidden width={TILE} height={TILE} loading="lazy"
            className="pointer-events-none absolute select-none"
            style={{ left: `${(t.left / W) * 100}%`, top: `${(t.top / H) * 100}%`, width: `${(TILE / W) * 100}%`, height: `${(TILE / H) * 100}%` }} />
        ))}
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full" role="img" aria-label={title}>
          {!tiles && (
            <g className="text-line" stroke="currentColor" strokeWidth={1}>
              {Array.from({ length: 9 }, (_, i) => <line key={`v${i}`} x1={(i + 1) * 64} y1={0} x2={(i + 1) * 64} y2={H} />)}
              {Array.from({ length: 5 }, (_, i) => <line key={`h${i}`} x1={0} y1={(i + 1) * 60} x2={W} y2={(i + 1) * 60} />)}
            </g>
          )}
          {line.length > 1 ? (
            <polyline points={linePts} fill="none" stroke="#1d6fe0" strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
          ) : connect && stops.length > 1 ? (
            <polyline points={stops.map((s) => px(s.point).join(",")).join(" ")} fill="none" stroke="#1d6fe0" strokeWidth={2} strokeDasharray="6 6" opacity={0.8} />
          ) : null}
          {markers(stops).map((m) => {
            const [x, y] = px(m.point);
            const text = m.numbers.join("/");
            const r = text.length > 2 ? 15 : 11;
            return (
              <g key={m.numbers[0]}>
                <title>{m.labels.join(" · ")}</title>
                <circle cx={x} cy={y} r={r} fill="#0c1a2b" stroke="#fff" strokeWidth={2} />
                <text x={x} y={y + 4} textAnchor="middle" fontSize={text.length > 2 ? 10 : 11} fontWeight={700} fill="#fff">{text}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="flex flex-wrap justify-between gap-2 border-t border-line px-3 py-1.5 text-xs text-muted">
        <span>{line.length > 1 ? "Road line from the routing provider." : connect && stops.length > 1 ? "Dashed: straight lines between stops, not roads." : stops.length > 1 ? "Numbers match the list." : "Location."}</span>
        <span>{tiles ? "Map © HERE" : "No map background: truck routing is not set up."}</span>
      </figcaption>
    </figure>
  );
}

/** One marker per place: a stop visited twice (a route back to the yard) shows both numbers, e.g. "1/4". */
function markers(stops: Array<{ point: Point; label: string }>) {
  const out: Array<{ point: Point; numbers: number[]; labels: string[] }> = [];
  stops.forEach((s, i) => {
    const same = out.find((m) => Math.abs(m.point.lat - s.point.lat) < 1e-5 && Math.abs(m.point.lng - s.point.lng) < 1e-5);
    if (same) {
      same.numbers.push(i + 1);
      if (!same.labels.includes(s.label)) same.labels.push(s.label);
    } else out.push({ point: s.point, numbers: [i + 1], labels: [s.label] });
  });
  return out;
}
