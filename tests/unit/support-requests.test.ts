// Support change requests (SA2): the stored form keeps only the fields the action reads, replays exactly, refuses
// files and unknown shapes; every requestable action records a request before doing anything during a visit.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPROVAL_SENT, approvalSentMessage, decodeArgs, encodeArgs, isApprovalSent, resultFields } from "@/lib/support-requests";

describe("support request encoding", () => {
  it("keeps only listed form fields and replays them as FormData", () => {
    const fd = new FormData();
    fd.set("role", "office"); fd.set("active", "on"); fd.set("sneaky", "owner");
    const enc = encodeArgs(["u-1", fd, true, null], ["role", "active"]);
    expect(enc).toEqual(["u-1", { $form: [["role", "office"], ["active", "on"]] }, true, null]);
    const back = decodeArgs(JSON.parse(JSON.stringify(enc)))!;
    expect(back[0]).toBe("u-1");
    expect(back[1]).toBeInstanceOf(FormData);
    expect(Object.fromEntries(back[1] as FormData)).toEqual({ role: "office", active: "on" });
    expect(back.slice(2)).toEqual([true, null]);
  });

  it("refuses files, objects and malformed storage", () => {
    const fd = new FormData();
    fd.set("photo", new Blob(["x"]), "x.png");
    expect(encodeArgs([fd], ["photo"])).toBeNull();
    expect(encodeArgs([{ a: 1 }])).toBeNull();
    expect(decodeArgs({})).toBeNull();
    expect(decodeArgs([{ $form: [["a"]] }])).toBeNull();
    expect(decodeArgs([{ other: 1 }])).toBeNull();
  });

  it("marks the sent message and lists one-time values for the owner", () => {
    const m = approvalSentMessage("Invite Pat as Driver");
    expect(m.startsWith(APPROVAL_SENT)).toBe(true);
    expect(isApprovalSent(m)).toBe(true);
    expect(isApprovalSent("Not allowed.")).toBe(false);
    expect(resultFields({ username: "pat", temporaryPassword: "Abc-123", userId: "x" })).toEqual([
      { label: "Username", value: "pat", secret: undefined },
      { label: "Temporary password", value: "Abc-123", secret: true },
    ]);
    expect(resultFields(undefined)).toEqual([]);
  });
});

describe("every requestable action asks first during a visit", () => {
  const HOOKS: Record<string, string[]> = {
    "src/server/people/invite.ts": ["people.invite_person", "people.invite"],
    "src/app/(app)/settings/actions.ts": ["people.access", "people.permission"],
    "src/app/(app)/employees/account-actions.ts": ["signin.create", "signin.reissue", "signin.email", "signin.off", "signin.on"],
    "src/app/(app)/customer-portal/account-actions.ts": ["portal.signin_create", "portal.signin_reissue", "portal.signin_email", "portal.signin_off", "portal.signin_on"],
    "src/app/(app)/customer-portal/actions.ts": ["portal.invite", "portal.revoke"],
    "src/app/(app)/fleet/drivers/phone-sign-in-actions.ts": ["signin.passkeys_remove"],
    "src/app/(app)/settings/accountant-actions.ts": ["accountant.invite", "accountant.change"],
  };
  it("has a hook, a description and a runner for each kind", () => {
    const spec = readFileSync("src/server/support/request.ts", "utf8");
    const runners = readFileSync("src/server/support/execute.ts", "utf8");
    const all = Object.values(HOOKS).flat();
    for (const [file, kinds] of Object.entries(HOOKS)) {
      const src = readFileSync(file, "utf8");
      for (const k of kinds) expect(src, `${file} ${k}`).toContain(`asSupportRequest("${k}"`);
    }
    for (const k of all) {
      expect(spec, k).toContain(`"${k}": {`);
      expect(runners, k).toContain(`"${k}": (`);
    }
    expect((spec.match(/^  "[a-z_.]+": \{/gm) ?? []).length).toBe(all.length);
  });
});
