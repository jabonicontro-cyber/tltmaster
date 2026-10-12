import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import type { UserKey } from "./users";

/**
 * Each role reaches only the pages its permissions cover — by direct URL, not
 * just by what the navigation shows. (Data-level checks are in tests/db.)
 */
const MATRIX: Record<string, { allowed: string[]; refused: string[] }> = {
  // Owners may use My Day; an owner who is not linked to a driver record is sent to the Command Center.
  owner: { allowed: ["/quotes", "/orders", "/dispatch", "/tickets", "/billing", "/fleet", "/command-center", "/field-reports", "/settings?tab=users", "/driver"], refused: [] },
  office: { allowed: ["/quotes", "/orders", "/dispatch", "/tickets", "/billing", "/fleet", "/command-center"], refused: ["/driver"] },
  dispatcher: { allowed: ["/orders", "/dispatch", "/tickets", "/command-center", "/fleet"], refused: ["/billing", "/driver"] },
  mechanic: { allowed: ["/fleet", "/command-center", "/field-reports"], refused: ["/quotes", "/orders", "/dispatch", "/tickets", "/billing", "/driver"] },
  driver: { allowed: ["/driver"], refused: ["/quotes", "/orders", "/dispatch", "/tickets", "/billing", "/fleet", "/field-reports"] },
};

for (const [role, { allowed, refused }] of Object.entries(MATRIX)) {
  test(`${role}: allowed and refused pages`, async ({ page }) => {
    await signIn(page, role as UserKey);
    for (const path of allowed) {
      await page.goto(path);
      if (role === "owner" && path === "/driver") await page.waitForURL(/\/command-center/);
      await expect(page, `${role} ${path}`).not.toHaveURL(/no-access/);
    }
    for (const path of refused) {
      await page.goto(path);
      await expect(page, `${role} ${path}`).toHaveURL(/no-access/);
    }
    // A driver-only account starts on its own day instead of the Command Center.
    if (role === "driver") {
      await page.goto("/command-center");
      await expect(page).toHaveURL(/\/driver$/);
    }
    // Users and permissions are owner-only by default.
    await page.goto("/settings?tab=users");
    if (role === "owner") await expect(page.getByRole("button", { name: "Invite user" })).toBeVisible();
    else await expect(page.getByRole("button", { name: "Invite user" })).toHaveCount(0);
  });
}
