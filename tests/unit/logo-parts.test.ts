import { describe, expect, it } from "vitest";
import { analyzeLogo, type Pixels } from "@/lib/logo-parts";

type Rect = [x: number, y: number, w: number, h: number];

/** A logo image: background (transparent or an opaque colour) with dark rectangles drawn on it. */
function logo(width: number, height: number, rects: Rect[], background: [number, number, number, number] = [0, 0, 0, 0]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(background, i * 4);
  for (const [x0, y0, w, h] of rects) for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([20, 50, 40, 255], (y * width + x) * 4);
  return { width, height, data };
}

describe("analyzeLogo", () => {
  it("finds a square mark left of the wordmark and trims empty margins", () => {
    // Northfield-like: 20px margins, a 120x120 mark, a 25px gap, then two lines of text.
    const parts = analyzeLogo(logo(480, 160, [[20, 20, 120, 120], [165, 45, 290, 40], [165, 100, 200, 15]]));
    expect(parts?.content).toEqual({ x: 20, y: 20, w: 435, h: 120 });
    expect(parts?.mark).toEqual({ x: 20, y: 20, w: 120, h: 120 });
    expect(parts?.markFilled).toBe(true);
  });

  it("finds the mark on an opaque white background", () => {
    const parts = analyzeLogo(logo(400, 120, [[10, 10, 100, 100], [130, 40, 250, 40]], [255, 255, 255, 255]));
    expect(parts?.mark).toEqual({ x: 10, y: 10, w: 100, h: 100 });
  });

  it("reports no mark for a wordmark with letter gaps", () => {
    // Letters 30px wide, 6px apart, 100px tall: gaps are under the minimum and no letter is square enough.
    const letters: Rect[] = Array.from({ length: 8 }, (_, i) => [10 + i * 36, 10, 30, 100] as Rect);
    expect(analyzeLogo(logo(320, 120, letters))?.mark).toBeNull();
  });

  it("reports no mark when the first block is short (a capital above a second line)", () => {
    const parts = analyzeLogo(logo(400, 120, [[10, 10, 60, 60], [90, 10, 300, 60], [10, 90, 380, 20]]));
    expect(parts?.mark).toBeNull();
  });

  it("returns null for an empty image", () => {
    expect(analyzeLogo(logo(50, 50, []))).toBeNull();
  });
});

describe("analyzeLogo on a card backdrop", () => {
  it("treats an opaque card with transparent corners as background", () => {
    const p = logo(300, 100, [[20, 15, 70, 70], [110, 35, 170, 30]], [255, 255, 255, 255]);
    for (const [x, y] of [[0, 0], [299, 0], [0, 99], [299, 99]]) p.data.set([0, 0, 0, 0], (y * 300 + x) * 4);
    expect(analyzeLogo(p)?.mark).toEqual({ x: 20, y: 15, w: 70, h: 70 });
  });
});
