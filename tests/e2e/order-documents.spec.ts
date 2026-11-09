import { expect, test } from "@playwright/test";
import { asUser } from "./db";
import { driverFixture } from "./driver-fixture";
import { expectToast, signIn } from "./helpers";
import { USERS } from "./users";

// Order documents (MK2, migration 20261120009500): the office adds the rate confirmation to an order and a proof of
// delivery for one of its stops; both open through a signed link; a file that is not a photo or PDF is refused by its
// content; removing one asks for a reason. Dispatchers see the documents but cannot add or remove them.

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

test("the office adds a rate confirmation and a proof of delivery for a stop, opens and removes one", async ({ browser }) => {
  test.slow();
  const fx = await driverFixture();
  await asUser(USERS.office.email, (q) => q("select public.save_order_stops($1, $2::jsonb)", [fx.orderId, JSON.stringify([
    { kind: "pickup", name: "Acme Steel (e2e)", city: "Gary", state: "IN" },
    { kind: "delivery", name: "Lakeside Build (e2e)", city: "Joliet", state: "IL" },
  ])]));
  const office = await (await browser.newContext()).newPage();
  await signIn(office, "office");
  await office.goto(`/orders/${fx.orderId}`);
  await expect(office.getByRole("heading", { name: "Documents" })).toBeVisible();

  await office.getByLabel("Document", { exact: true }).selectOption("rate_confirmation");
  await office.getByLabel("File (photo or PDF, up to 10 MB)").setInputFiles({ name: "rate-con-4411.pdf", mimeType: "application/pdf", buffer: PDF });
  await expectToast(office, "Rate confirmation added.");
  await office.getByLabel("Document", { exact: true }).selectOption("proof_of_delivery");
  await office.getByLabel("For", { exact: true }).selectOption({ label: "Delivery 2: Lakeside Build (e2e)" });
  await office.getByLabel("File (photo or PDF, up to 10 MB)").setInputFiles({ name: "signed-bol.pdf", mimeType: "application/pdf", buffer: PDF });
  await expectToast(office, "Proof of delivery added.");

  const list = office.getByRole("list", { name: "Order documents" });
  await expect(list).toContainText("Rate confirmation");
  await expect(list).toContainText("Proof of delivery · Delivery 2: Lakeside Build (e2e)");
  // A renamed file that is not really a PDF is refused by its content.
  await office.getByLabel("File (photo or PDF, up to 10 MB)").setInputFiles({ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
  await expect(office.getByText(/photos \(JPEG, PNG, WebP\) or PDFs only/)).toBeVisible();

  // Opening goes through a short signed link to the private store.
  const href = await list.getByRole("link", { name: "Rate confirmation" }).getAttribute("href");
  const opened = await office.request.get(href!, { maxRedirects: 0 });
  expect(opened.status()).toBe(302);
  expect(opened.headers()["location"]).toMatch(/order-documents/);

  // Dispatchers see them, without add or remove.
  const dispatcher = await (await browser.newContext()).newPage();
  await signIn(dispatcher, "dispatcher");
  await dispatcher.goto(`/orders/${fx.orderId}`);
  await expect(dispatcher.getByRole("list", { name: "Order documents" })).toContainText("Rate confirmation");
  await expect(dispatcher.getByLabel("File (photo or PDF, up to 10 MB)")).toHaveCount(0);
  await expect(dispatcher.getByRole("button", { name: /^Remove / })).toHaveCount(0);

  // Removing asks for a reason and keeps the record.
  await list.getByRole("button", { name: "Remove Rate confirmation" }).click();
  await office.getByLabel("Reason to remove the document").fill("Wrong load (e2e)");
  await office.getByRole("button", { name: "Remove document" }).click();
  await expectToast(office, /Document removed/);
  await expect(list).not.toContainText("rate-con-4411.pdf");
  await expect(list).toContainText("signed-bol.pdf");
});
