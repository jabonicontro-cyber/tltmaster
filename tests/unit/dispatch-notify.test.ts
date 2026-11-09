import { describe, expect, it } from "vitest";
import { driverNoticeText } from "@/lib/dispatch/notify";
import { missingPermissionText, PERMISSION_WORDS, permissionWords, rolesPhrase } from "@/lib/permission-words";
import { PERMISSIONS } from "@/lib/permissions";

describe("how the driver is told after an assignment", () => {
  it("names My Day for a driver with a sign-in, and says to call one without", () => {
    expect(driverNoticeText([{ name: "Marco Delgado", hasSignIn: true }])).toBe("Marco Delgado will see it in My Day.");
    expect(driverNoticeText([{ name: "Marco Delgado", hasSignIn: false }])).toBe("Marco Delgado has no Taviron sign-in: call them.");
  });
  it("groups several drivers and loads", () => {
    expect(driverNoticeText([{ name: "Ann", hasSignIn: true }, { name: "Ann", hasSignIn: true }])).toBe("Ann will see them in My Day.");
    expect(driverNoticeText([{ name: "Ann", hasSignIn: true }, { name: "Bo", hasSignIn: true }, { name: "Cy", hasSignIn: false }, { name: "Di", hasSignIn: false }]))
      .toBe("Ann and Bo will see them in My Day. Cy and Di have no Taviron sign-in: call each of them.");
    expect(driverNoticeText([])).toBe("");
  });
});

describe("missing permissions in plain words", () => {
  it("has words for every permission and never shows a code", () => {
    for (const p of PERMISSIONS) expect(PERMISSION_WORDS[p], p).toMatch(/^[a-z]/);
    expect(permissionWords("orders.edit")).toBe("creating and changing orders");
    expect(permissionWords("nonsense.code")).toBe("this page");
    for (const p of PERMISSIONS) expect(missingPermissionText(p, ["owner"])).not.toContain(p);
  });
  it("says which roles can do it, from the company's own role settings", () => {
    expect(missingPermissionText("orders.edit", ["owner", "office", "dispatcher"])).toBe(
      "Creating and changing orders is not part of your role. Here it is part of the Owner / Administrator, Office staff and Dispatcher roles: ask one of them, or ask an owner to add it to your role (Settings → Roles and permissions).",
    );
    expect(missingPermissionText("orders.edit", null)).toBe("Creating and changing orders is not part of your role. If you need it, ask an owner to add it to your role (Settings → Roles and permissions).");
    expect(missingPermissionText(undefined, null)).toBe("Your role does not include this. Ask an owner if you need it.");
    expect(rolesPhrase(["owner", "dispatcher"])).toBe("the Owner / Administrator and Dispatcher roles");
    expect(rolesPhrase(null)).toBe("the owner's role");
  });
});
