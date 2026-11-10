"use client";

import qrcode from "qrcode-generator";
import { useMemo } from "react";

/**
 * A QR code drawn as SVG (qrcode-generator, MIT). Always dark modules on a light square with a quiet zone, whatever the
 * app's theme: phone cameras read dark-on-light codes reliably, and the code must stay scannable in dark mode.
 */
export function QrCode({ value, size = 256, label, testId }: { value: string; size?: number; label: string; testId?: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value, "Byte");
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { path: d, count: n };
  }, [value]);
  const box = count + 8;
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid={testId}
      viewBox={`0 0 ${box} ${box}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="max-w-full rounded-xl"
    >
      <rect width={box} height={box} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
