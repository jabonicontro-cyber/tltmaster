import { expect, test } from "@playwright/test";
import { expectToast, signInPlatform, unique } from "./helpers";

// Outreach (master plan B139): the platform team saves the email, adds carriers from a registry export, prepares and
// records an email, and the company's unsubscribe link stops all further contact. Nothing is sent by Taviron.

test("outreach: from a carrier list to an email, and the unsubscribe link stops further contact", async ({ page, browser }) => {
  test.slow();
  const id = unique().toLowerCase();
  const email = `dispatch-${id}@hauling.example`;
  const company = `ACME HAULING ${id.toUpperCase()} LLC`;
  await signInPlatform(page);

  // The email needs a sender and a postal address first.
  await page.goto("/admin/outreach?tab=email");
  await page.getByLabel("Sender's name").fill("Jordan Lee");
  await page.getByLabel("Postal address").fill("PO Box 100, Waco, TX 76701");
  await page.getByRole("button", { name: "Save email" }).click();
  await expectToast(page, "Email saved.");

  // A registry export with one match, one carrier outside the filters and one without an email.
  await page.goto("/admin/outreach?tab=add");
  const csv = [
    "DOT_NUMBER,LEGAL_NAME,PHY_CITY,PHY_STATE,EMAIL_ADDRESS,COMPANY_OFFICER_1,NBR_POWER_UNIT,STATUS_CODE,CRGO_GENFREIGHT,CRGO_CONSTMATL",
    `1234567,"${company}",WACO,TX,${email},JOHN SMITH,12,A,,X`,
    `2345678,OTHER STATE ${id},TULSA,OK,ok-${id}@hauling.example,MARY,12,A,,X`,
    `3456789,NO EMAIL ${id},DALLAS,TX,,BOB,12,A,,X`,
  ].join("\n");
  await page.getByLabel("Carrier list (CSV)").setInputFiles({ name: "census.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByLabel("States (blank for all)").fill("TX");
  await expect(page.getByTestId("outreach-preview")).toContainText("1 of 3 companies");
  await page.getByRole("button", { name: "Add 1 to the list" }).click();
  await expect(page.getByText(/1 added/)).toBeVisible();

  // The company and its prepared email.
  // Registry names come in capitals; they are softened ("Acme Hauling ... LLC").
  await page.goto(`/admin/outreach?q=${encodeURIComponent(email)}`);
  await page.getByRole("table", { name: "Outreach companies" }).getByRole("link", { name: /^Acme Hauling .+ LLC$/ }).click();
  const preview = page.getByLabel("Email preview");
  await expect(preview).toContainText(/Less paperwork for Acme Hauling .+ LLC\?/);
  await expect(preview).toContainText("Hi John,");
  await expect(preview).toContainText("Common questions");
  await expect(preview).toContainText("PO Box 100, Waco, TX 76701");
  await expect(page.getByRole("link", { name: "Open in Gmail" })).toHaveAttribute("href", /mail\.google\.com/);
  await page.getByRole("button", { name: "I sent it" }).click();
  await expectToast(page, "Marked as sent.");
  await expect(page.getByLabel("History")).toContainText("Email sent");

  // The unsubscribe link works without signing in, past the early-access gate, and needs a confirmation.
  const link = (await preview.textContent())!.match(/https?:\/\/\S+\/unsubscribe\/([0-9a-f]{32})/)!;
  const visitor = await browser.newContext();
  const v = await visitor.newPage();
  await v.goto(`/unsubscribe/${link[1]}`);
  await expect(v.getByRole("heading", { name: "Stop emails from Taviron?" })).toBeVisible();
  await v.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(v.getByRole("heading", { name: "You're unsubscribed." })).toBeVisible();
  await visitor.close();

  await page.reload();
  await expect(page.getByText("This company asked not to be contacted. No email can be prepared.")).toBeVisible();
  await expect(page.getByLabel("History")).toContainText("Unsubscribed from the email link");
  await expect(page.getByRole("button", { name: "Add to Leads" })).toHaveCount(0);
});
