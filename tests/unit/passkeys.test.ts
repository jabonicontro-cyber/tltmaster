// Face or fingerprint sign-in (DS1): the browser-side conversions between Supabase Auth's JSON options and the WebAuthn
// API, matching the WebAuthn Level 3 JSON format that @supabase/auth-js sends.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, creationOptionsFromJson, credentialToJson, passkeyErrorMessage, passkeyRefusalMessage, requestOptionsFromJson } from "@/lib/passkeys";
import { isMoneyPermission, MONEY_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64url");
const buf = (bytes: number[]) => new Uint8Array(bytes).buffer;

describe("passkey conversions", () => {
  it("round-trips base64url", () => {
    for (const bytes of [[], [0], [255, 254], [1, 2, 3, 4, 5], Array.from({ length: 65 }, (_, i) => (i * 37) % 256)]) {
      expect(Array.from(base64UrlToBytes(b64(bytes)))).toEqual(bytes);
      expect(bytesToBase64Url(new Uint8Array(bytes))).toBe(b64(bytes));
    }
  });

  it("turns creation options into buffers (also when wrapped in publicKey)", () => {
    const json = {
      challenge: b64([1, 2, 3]),
      rp: { id: "tltmaster.vercel.app", name: "Taviron" },
      user: { id: b64([9, 9]), name: "quinn", displayName: "Quinn" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ id: b64([7]), type: "public-key", transports: ["internal"] }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: 60000,
    };
    for (const raw of [json, { publicKey: json }]) {
      const o = creationOptionsFromJson(raw);
      expect(Array.from(new Uint8Array(o.challenge as ArrayBuffer))).toEqual([1, 2, 3]);
      expect(Array.from(new Uint8Array(o.user.id as ArrayBuffer))).toEqual([9, 9]);
      expect(o.user.name).toBe("quinn");
      expect(o.rp).toEqual({ id: "tltmaster.vercel.app", name: "Taviron" });
      expect(Array.from(new Uint8Array(o.excludeCredentials![0].id as ArrayBuffer))).toEqual([7]);
      expect(o.excludeCredentials![0].transports).toEqual(["internal"]);
      expect(o.authenticatorSelection).toEqual({ residentKey: "required", userVerification: "required" });
    }
  });

  it("turns request options into buffers; no allowCredentials for discoverable sign-in", () => {
    const o = requestOptionsFromJson({ challenge: b64([4, 5]), rpId: "tltmaster.vercel.app", userVerification: "required" });
    expect(Array.from(new Uint8Array(o.challenge as ArrayBuffer))).toEqual([4, 5]);
    expect(o.rpId).toBe("tltmaster.vercel.app");
    expect(o.allowCredentials).toBeUndefined();
    const withList = requestOptionsFromJson({ publicKey: { challenge: b64([4]), allowCredentials: [{ id: b64([3, 3]) }] } });
    expect(Array.from(new Uint8Array(withList.allowCredentials![0].id as ArrayBuffer))).toEqual([3, 3]);
  });

  it("serializes registration and sign-in answers", () => {
    const reg = credentialToJson({
      id: b64([1, 1]), rawId: buf([1, 1]), type: "public-key", authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: buf([2]), attestationObject: buf([3]), getTransports: () => ["internal", "hybrid"] },
    });
    expect(reg).toEqual({
      id: b64([1, 1]), rawId: b64([1, 1]), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
      response: { clientDataJSON: b64([2]), attestationObject: b64([3]), transports: ["internal", "hybrid"] },
    });
    const auth = credentialToJson({
      id: b64([1]), rawId: buf([1]), type: "public-key", authenticatorAttachment: null, getClientExtensionResults: () => ({}),
      response: { clientDataJSON: buf([2]), authenticatorData: buf([4]), signature: buf([5]), userHandle: buf([6]) },
    });
    expect(auth.response).toEqual({ clientDataJSON: b64([2]), authenticatorData: b64([4]), signature: b64([5]), userHandle: b64([6]) });
    expect("authenticatorAttachment" in auth).toBe(false);
  });

  it("explains a cancelled or unsupported ceremony in plain words", () => {
    expect(passkeyErrorMessage("NotAllowedError")).toMatch(/cancelled/);
    expect(passkeyErrorMessage("InvalidStateError")).toMatch(/already set up/);
    expect(passkeyErrorMessage("SecurityError")).toMatch(/cannot use/);
    expect(passkeyErrorMessage(undefined)).toMatch(/did not work/);
  });
});

describe("who may sign in without typing (SEC4)", () => {
  it("treats every billing, pricing, pay, compensation, accounting, cost, audit, settings and user-management permission as money", () => {
    const money = PERMISSIONS.filter(isMoneyPermission);
    expect([...money].sort()).toEqual(["accounting.view", "audit.view", "billing.manage", "billing.view", "employees.compensation", "maintenance.costs", "payroll.manage", "pricing.edit", "pricing.override", "settings.manage", "users.manage"]);
    expect(isMoneyPermission("billing.anything_new")).toBe(true);
    expect(isMoneyPermission("pricing.anything_new")).toBe(true);
    for (const p of ["driver.portal", "comms.message", "tickets.edit", "maintenance.view", "quotes.view"]) expect(isMoneyPermission(p), p).toBe(false);
  });

  it("the migration's list is the app's list", () => {
    const sql = readFileSync("supabase/migrations/20261120017100_signin_qr_money_rule.sql", "utf8");
    const fn = sql.slice(sql.indexOf("function private.is_money_permission"), sql.indexOf("function private.holds_money_permission"));
    expect(fn).toContain("p_permission like 'billing.%'");
    expect(fn).toContain("p_permission like 'pricing.%'");
    const listed = [...fn.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]).sort();
    // billing.* and pricing.* are matched by prefix in SQL; every other money permission is named.
    expect(listed).toEqual(MONEY_PERMISSIONS.filter((p) => !/^(billing|pricing)\./.test(p)).sort());
  });

  it("says why face or fingerprint is refused and what to do instead", () => {
    expect(passkeyRefusalMessage("staff")).toMatch(/Taviron team.*authenticator app/);
    expect(passkeyRefusalMessage("money")).toMatch(/money.*password/);
    expect(passkeyRefusalMessage("not_driver")).toMatch(/driver sign-ins/);
    expect(passkeyRefusalMessage("demo")).toMatch(/Demo/);
    expect(passkeyRefusalMessage("unavailable")).toMatch(/password/);
    for (const r of ["signed_out", "staff", "money", "demo", "not_driver", "unavailable", "other"]) expect(passkeyRefusalMessage(r)).not.toMatch(/[\u2014]/);
  });
});
