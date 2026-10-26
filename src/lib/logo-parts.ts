// Company logo analysis for the sidebar (redesign, owner 2026-10-26): logos are uploaded as one image, often with
// empty margins and a separate mark beside the wordmark (Northfield: a square emblem, then the name). The expanded
// sidebar shows the logo trimmed to its content so it fills its tile; the collapsed rail shows the mark alone. A
// wordmark-only logo has no mark, and the rail keeps the monogram. Pure pixel logic so it can be unit tested; the
// browser part (canvas) lives in the sidebar component.

export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA, row by row
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LogoParts {
  /** The logo's content without empty margins. */
  content: Box;
  /** A separate mark at the left of the logo, or null when the logo is a wordmark only. */
  mark: Box | null;
  /** Whether the mark carries its own solid background (shown as is) rather than shapes on transparency. */
  markFilled: boolean;
}

/**
 * Pixels that count as background: transparent ones, and those close to the logo's backdrop colour — the most common
 * opaque colour along its edges (a white card, possibly with transparent rounded corners).
 */
function backgroundTest(p: Pixels): (i: number) => boolean {
  const d = p.data;
  const counts = new Map<number, number>();
  let opaque = 0;
  const visit = (x: number, y: number) => {
    const i = (y * p.width + x) * 4;
    if (d[i + 3] < 240) return;
    opaque++;
    const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < p.width; x++) {
    visit(x, 0);
    visit(x, p.height - 1);
  }
  for (let y = 1; y < p.height - 1; y++) {
    visit(0, y);
    visit(p.width - 1, y);
  }
  let backdrop: [number, number, number] | null = null;
  let best = 0;
  for (const [key, n] of counts) {
    if (n > best) {
      best = n;
      backdrop = [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4];
    }
  }
  if (best < opaque * 0.5) backdrop = null;
  return (i: number) => {
    if (d[i + 3] < 24) return true;
    if (!backdrop) return false;
    return Math.abs(d[i] - backdrop[0]) + Math.abs(d[i + 1] - backdrop[1]) + Math.abs(d[i + 2] - backdrop[2]) < 40;
  };
}

function rowsOf(p: Pixels, isBg: (i: number) => boolean, x0: number, x1: number): { y0: number; y1: number } | null {
  let y0 = -1;
  let y1 = -1;
  for (let y = 0; y < p.height; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!isBg((y * p.width + x) * 4)) {
        if (y0 < 0) y0 = y;
        y1 = y;
        break;
      }
    }
  }
  return y0 < 0 ? null : { y0, y1 };
}

export function analyzeLogo(p: Pixels): LogoParts | null {
  const { width, height } = p;
  if (width < 4 || height < 4) return null;
  const isBg = backgroundTest(p);
  const filledCol = new Array<boolean>(width);
  for (let x = 0; x < width; x++) {
    let filled = false;
    for (let y = 0; y < height && !filled; y++) filled = !isBg((y * width + x) * 4);
    filledCol[x] = filled;
  }
  const first = filledCol.indexOf(true);
  if (first < 0) return null;
  const last = filledCol.lastIndexOf(true);
  const rows = rowsOf(p, isBg, first, last)!;
  const content = { x: first, y: rows.y0, w: last - first + 1, h: rows.y1 - rows.y0 + 1 };

  // A mark is a block at the left, separated from the rest by a clear vertical gap, roughly square, nearly as tall as
  // the whole logo and well under half its width. Letters of a wordmark fail these tests (small gaps, short or narrow).
  const minGap = Math.max(4, Math.round(content.h * 0.08));
  let end = first;
  while (end <= last && filledCol[end]) end++;
  let gapEnd = end;
  while (gapEnd <= last && !filledCol[gapEnd]) gapEnd++;
  let mark: Box | null = null;
  let markFilled = false;
  if (gapEnd <= last && gapEnd - end >= minGap) {
    const r = rowsOf(p, isBg, first, end - 1)!;
    const box = { x: first, y: r.y0, w: end - first, h: r.y1 - r.y0 + 1 };
    const ratio = box.w / box.h;
    if (ratio >= 0.6 && ratio <= 1.6 && box.h >= content.h * 0.75 && box.w <= content.w * 0.45) {
      mark = box;
      let solid = 0;
      for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) if (!isBg((y * width + x) * 4)) solid++;
      markFilled = solid / (box.w * box.h) > 0.8;
    }
  }
  return { content, mark, markFilled };
}
