import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { PASSWORD, USERS } from "./users";

test("anonymous visitors are sent to sign in, then back to the page they wanted", async ({ page }) => {
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login\?next=%2Fcustomers/);
  await page.getByLabel("Email").fill(USERS.office.email);
  await page.getByLabel("Password").fill("definitely-wrong");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
  // The email is kept after a failed attempt.
  await expect(page.getByLabel("Email")).toHaveValue(USERS.office.email);
});

test("sign in lands on the Command Center and sign out returns to sign in", async ({ page }) => {
  await signIn(page, "office");
  await expect(page).toHaveURL(/\/command-center/);
  await expect(page.getByRole("heading", { name: "Command Center", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /Omar Office/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/command-center");
  await expect(page).toHaveURL(/\/login/);
});

test("private pages are never indexed", async ({ request }) => {
  const res = await request.get("/login");
  expect(res.headers()["x-robots-tag"]).toContain("noindex");
  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toContain("Disallow: /");
});

test("the logo on the sign-in page goes to the public website, in the same tab, by mouse or keyboard", async ({ page }) => {
  // The sandbox cannot reach the real site: answer for it so the navigation itself is checked.
  await page.route("https://mytaviron.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Taviron website</title>" }));
  for (const path of ["/login", "/forgot-password"]) {
    await page.goto(path);
    const logo = page.getByRole("link", { name: "Taviron website" });
    await expect(logo, path).toHaveAttribute("href", "https://mytaviron.com");
    await expect(logo, path).not.toHaveAttribute("target", /.+/);
  }
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeFocused(); // the form starts focused; the logo comes just before it
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("link", { name: "Taviron website" })).toBeFocused();
  const pages = page.context().pages().length;
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("https://mytaviron.com/");
  expect(page.context().pages().length).toBe(pages); // same tab
});

test("after sign-in, a 'next' that a browser would read as another site is ignored", async ({ page }) => {
  await page.goto(`/login?next=${encodeURIComponent("/\t/evil.example")}`);
  await page.getByLabel("Email").fill(USERS.office.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/localhost:\d+\/command-center/);
});
