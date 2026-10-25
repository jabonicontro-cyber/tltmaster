// Decoder for HERE's flexible polyline (https://github.com/heremaps/flexible-polyline, MIT): the route line in a
// HERE routing answer. Arithmetic instead of bit operations, because scaled coordinates exceed 32 bits.

import type { Point } from "./route";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i]));

function* unsignedValues(encoded: string): Generator<number> {
  let result = 0;
  let factor = 1;
  for (const ch of encoded) {
    const v = VALUE.get(ch);
    if (v === undefined) throw new Error("Invalid polyline character.");
    result += (v % 32) * factor;
    if (v >= 32) {
      factor *= 32;
    } else {
      yield result;
      result = 0;
      factor = 1;
    }
  }
  if (factor !== 1) throw new Error("Polyline ends in the middle of a value.");
}

const toSigned = (u: number) => (u % 2 === 1 ? -(u + 1) / 2 : u / 2);

/** The points of a flexible polyline (a third dimension, when present, is read and dropped). */
export function decodeFlexPolyline(encoded: string): Point[] {
  const values = unsignedValues(encoded);
  const version = values.next();
  if (version.done || version.value !== 1) throw new Error("Unsupported polyline version.");
  const header = values.next();
  if (header.done) throw new Error("Polyline header is missing.");
  const precision = header.value % 16;
  const thirdDim = Math.floor(header.value / 16) % 8;
  const scale = 10 ** precision;
  const points: Point[] = [];
  let lat = 0;
  let lng = 0;
  for (;;) {
    const a = values.next();
    if (a.done) break;
    const b = values.next();
    if (b.done) throw new Error("Polyline has an odd number of values.");
    lat += toSigned(a.value);
    lng += toSigned(b.value);
    if (thirdDim) {
      const c = values.next();
      if (c.done) throw new Error("Polyline is missing a third-dimension value.");
    }
    points.push({ lat: Math.round((lat / scale) * 1e6) / 1e6, lng: Math.round((lng / scale) * 1e6) / 1e6 });
  }
  return points;
}
