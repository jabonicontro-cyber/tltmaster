import { expect, test } from "@playwright/test";
import { expectToast, signIn } from "./helpers";
import { asUser } from "./db";
import { USERS } from "./users";

// Progressive US phone formatting in a real browser: typing, pasting, editing
// in the middle, backspacing over formatting, and saving the formatted value.

test.afterAll(async () => {
  await asUser(USERS.office.email, (q) => q("select public.update_my_profile('', '')"));
});

test("phone fields format as you type, paste and edit, and save the formatted number", async ({ page }) => {
  await signIn(page, "office");
  await page.goto("/profile");
  const phone = page.getByLabel("Phone");

  await phone.click();
  for (const [key, shown] of [["1", "1"], ["2", "12"], ["3", "123"], ["4", "(123) 4"], ["5", "(123) 45"], ["6", "(123) 456"], ["7", "(123) 456-7"]] as const) {
    await page.keyboard.type(key);
    await expect(phone).toHaveValue(shown);
  }
  await page.keyboard.type("890");
  await expect(phone).toHaveValue("(123) 456-7890");

  // Backspace right after ") " removes the digit before it instead of getting stuck.
  await phone.fill("");
  await page.keyboard.type("1234");
  await expect(phone).toHaveValue("(123) 4");
  await phone.evaluate((el: HTMLInputElement) => el.setSelectionRange(6, 6));
  await page.keyboard.press("Backspace");
  await expect(phone).toHaveValue("124");

  // Editing in the middle keeps the caret after the typed digit.
  await phone.fill("");
  await page.keyboard.type("312456789");
  await phone.evaluate((el: HTMLInputElement) => el.setSelectionRange(8, 8)); // after "(312) 45"
  await page.keyboard.type("9");
  await expect(phone).toHaveValue("(312) 459-6789");
  expect(await phone.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(9);

  // Paste in another shape; international numbers are left alone.
  await phone.fill("");
  await page.keyboard.insertText("312.555.0142"); // one input event with the whole text, as a paste produces
  await expect(phone).toHaveValue("(312) 555-0142");
  await phone.fill("+44 20 7946 0958");
  await expect(phone).toHaveValue("+44 20 7946 0958");

  await phone.fill("3125550142");
  await expect(phone).toHaveValue("(312) 555-0142");
  await page.getByRole("button", { name: "Save" }).click();
  await expectToast(page, "Profile saved.");
  const saved = await asUser(USERS.office.email, async (q) => (await q("select public.my_profile()->>'phone' as phone")).rows[0].phone);
  expect(saved).toBe("(312) 555-0142");
});
