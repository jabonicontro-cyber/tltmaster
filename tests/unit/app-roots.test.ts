import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROOTS, isAppPath } from "@/lib/app-roots";

// UX12: unknown public addresses show "page not found"; app addresses still ask a signed-out visitor to sign in.
const dirs = (p: string) => readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory());

describe("app roots", () => {
  it("lists every app, auth and top-level route folder", () => {
    const expected = new Set([...dirs("src/app/(app)"), ...dirs("src/app/(auth)"), ...dirs("src/app").filter((n) => !n.startsWith("("))]);
    expect([...APP_ROOTS].sort()).toEqual([...expected].sort());
  });

  it("tells app paths from unknown addresses", () => {
    expect(isAppPath("/dispatch")).toBe(true);
    expect(isAppPath("/orders/123")).toBe(true);
    expect(isAppPath("/")).toBe(true);
    expect(isAppPath("/compare")).toBe(false);
    expect(isAppPath("/anything")).toBe(false);
  });
});
