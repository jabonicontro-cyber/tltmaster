export const PASSWORD = process.env.E2E_PASSWORD ?? "E2E-Test-Passw0rd!";

export const USERS = {
  owner: { email: "e2e-owner@toplinetest.example", name: "Erin Owner", role: "owner" },
  office: { email: "e2e-office@toplinetest.example", name: "Omar Office", role: "office" },
  dispatcher: { email: "e2e-dispatch@toplinetest.example", name: "Dana Dispatch", role: "dispatcher" },
  pending: { email: "e2e-pending@toplinetest.example", name: "Pat Pending", role: null },
} as const;

export type UserKey = keyof typeof USERS;
