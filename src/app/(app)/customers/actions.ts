"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { contactSchema, customerSchema, siteSchema } from "@/lib/schemas/customer";
import { optionalEmail, optionalPhone, optionalText, uuid } from "@/lib/schemas/common";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage, guard, validationFailure } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

const firstContactSchema = z.object({
  contact_name: optionalText(120),
  contact_email: optionalEmail,
  contact_phone: optionalPhone,
});

export async function createCustomer(formData: FormData): Promise<ActionResult<{ id: string }>> {
  let createdId: string | null = null;
  let contactFailed = false;
  const result = await guard(async () => {
    await assertPermission("customers.edit");
    const raw = Object.fromEntries(formData);
    const parsed = customerSchema.safeParse(raw);
    const contact = firstContactSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    if (!contact.success) return validationFailure(contact.error);

    const supabase = await createClient();
    const { data, error } = await supabase.from("customers").insert(parsed.data).select("id").single();
    if (error) return fail(dbErrorMessage(error));

    if (contact.data.contact_name) {
      const { error: cErr } = await supabase.from("customer_contacts").insert({
        customer_id: data.id,
        name: contact.data.contact_name,
        email: contact.data.contact_email,
        phone: contact.data.contact_phone,
        is_primary: true,
        is_billing: true,
      });
      if (cErr) contactFailed = true;
    }
    createdId = data.id;
    revalidatePath("/customers");
    return ok({ id: data.id });
  });
  if (createdId && result.ok) redirect(`/customers/${createdId}?created=1${contactFailed ? "&contact=failed" : ""}`);
  return result;
}

/** Used from the quote editor: create a customer without leaving the page. */
export async function quickCreateCustomer(formData: FormData): Promise<ActionResult<{ id: string; name: string; customer_number: string }>> {
  return guard(async () => {
    await assertPermission("customers.edit");
    const raw = Object.fromEntries(formData);
    const parsed = customerSchema.safeParse(raw);
    const contact = firstContactSchema.safeParse(raw);
    if (!parsed.success) return validationFailure(parsed.error);
    if (!contact.success) return validationFailure(contact.error);
    const supabase = await createClient();
    const { data, error } = await supabase.from("customers").insert(parsed.data).select("id, name, customer_number").single();
    if (error) return fail(dbErrorMessage(error));
    let contactFailed = false;
    if (contact.data.contact_name) {
      const { error: cErr } = await supabase.from("customer_contacts").insert({
        customer_id: data.id,
        name: contact.data.contact_name,
        email: contact.data.contact_email,
        phone: contact.data.contact_phone,
        is_primary: true,
        is_billing: true,
      });
      contactFailed = Boolean(cErr);
    }
    revalidatePath("/customers");
    return ok(data, contactFailed ? "Customer created, but the contact could not be saved. Add it on the customer page." : undefined);
  });
}

export async function updateCustomer(id: string, formData: FormData): Promise<ActionResult<{ id: string }>> {
  let done = false;
  const result = await guard(async () => {
    await assertPermission("customers.edit");
    const idOk = uuid.safeParse(id);
    if (!idOk.success) return fail("Invalid customer.");
    const parsed = customerSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { data, error } = await supabase.from("customers").update(parsed.data).eq("id", id).select("id");
    if (error) return fail(dbErrorMessage(error));
    if (!data || data.length === 0) return fail("Customer not found or you do not have permission to edit it.");
    done = true;
    revalidatePath("/customers");
    revalidatePath(`/customers/${id}`);
    return ok({ id });
  });
  if (done && result.ok) redirect(`/customers/${id}?saved=1`);
  return result;
}

export async function setCustomerActive(id: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("customers.edit");
    if (!uuid.safeParse(id).success) return fail("Invalid customer.");
    const supabase = await createClient();
    const { data, error } = await supabase.from("customers").update({ active }).eq("id", id).select("id");
    if (error) return fail(dbErrorMessage(error));
    if (!data?.length) return fail("Customer not found.");
    revalidatePath("/customers");
    revalidatePath(`/customers/${id}`);
    return ok(undefined, active ? "Customer reactivated." : "Customer archived.");
  });
}

export async function saveContact(customerId: string, contactId: string | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("customers.edit");
    if (!uuid.safeParse(customerId).success || (contactId && !uuid.safeParse(contactId).success)) return fail("Invalid record.");
    const parsed = contactSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();

    if (parsed.data.is_primary) {
      let clear = supabase.from("customer_contacts").update({ is_primary: false }).eq("customer_id", customerId).eq("is_primary", true);
      if (contactId) clear = clear.neq("id", contactId);
      const { error } = await clear;
      if (error) return fail(dbErrorMessage(error));
    }

    const { error } = contactId
      ? await supabase.from("customer_contacts").update(parsed.data).eq("id", contactId).eq("customer_id", customerId)
      : await supabase.from("customer_contacts").insert({ ...parsed.data, customer_id: customerId });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/customers/${customerId}`);
    return ok(undefined, contactId ? "Contact updated." : "Contact added.");
  });
}

export async function setContactActive(customerId: string, contactId: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("customers.edit");
    const supabase = await createClient();
    const { error } = await supabase
      .from("customer_contacts")
      .update(active ? { active } : { active, is_primary: false })
      .eq("id", contactId)
      .eq("customer_id", customerId);
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/customers/${customerId}`);
    return ok(undefined, active ? "Contact restored." : "Contact archived.");
  });
}

export async function saveSite(customerId: string, siteId: string | null, formData: FormData): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("customers.edit");
    if (!uuid.safeParse(customerId).success || (siteId && !uuid.safeParse(siteId).success)) return fail("Invalid record.");
    const parsed = siteSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return validationFailure(parsed.error);
    const supabase = await createClient();
    const { error } = siteId
      ? await supabase.from("customer_sites").update(parsed.data).eq("id", siteId).eq("customer_id", customerId)
      : await supabase.from("customer_sites").insert({ ...parsed.data, customer_id: customerId });
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/customers/${customerId}`);
    return ok(undefined, siteId ? "Job site updated." : "Job site added.");
  });
}

export async function setSiteActive(customerId: string, siteId: string, active: boolean): Promise<ActionResult> {
  return guard(async () => {
    await assertPermission("customers.edit");
    const supabase = await createClient();
    const { error } = await supabase.from("customer_sites").update({ active }).eq("id", siteId).eq("customer_id", customerId);
    if (error) return fail(dbErrorMessage(error));
    revalidatePath(`/customers/${customerId}`);
    return ok(undefined, active ? "Job site restored." : "Job site archived.");
  });
}
