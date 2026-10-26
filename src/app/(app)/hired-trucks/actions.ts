"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { isOperationalDate } from "@/lib/dates";
import { DOC_KINDS, EXPIRY_REQUIRED, RATE_UNITS, TRUCK_DOCS, type DocKind } from "@/lib/hired-trucks";
import { TRUCK_TYPES } from "@/lib/fleet/labels";
import { assertPermission } from "@/server/auth";
import { dbErrorMessage } from "@/server/errors";
import { createClient } from "@/server/supabase/server";

// Hired trucks (B83). Every action is checked again in the database (permission, add-on switch, documents, company).
// Results come back as ?error= / ?saved= so every form works without JavaScript.

const PAGE = "/hired-trucks";
const uuid = z.uuid();
const back = (error: string, path = PAGE): never => redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(error.slice(0, 300))}`);
const done = (saved: string, path = PAGE): never => {
  revalidatePath(PAGE);
  revalidatePath("/dispatch");
  revalidatePath("/driver");
  // The flash message's own name is the query key (FlashToast on the page).
  redirect(`${path}${path.includes("?") ? "&" : "?"}${saved}=1`);
};
const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const id = (f: FormData, k: string) => {
  const v = text(f, k);
  return uuid.safeParse(v).success ? v : null;
};

async function db(permission: "fleet.edit" | "dispatch.edit", path = PAGE) {
  try {
    await assertPermission(permission);
  } catch {
    back(permission === "fleet.edit" ? "Only people who manage the fleet can do this." : "Only dispatchers can do this.", path);
  }
  return createClient();
}

export async function saveHauler(f: FormData) {
  const supabase = await db("fleet.edit");
  const name = text(f, "name");
  if (!name) back("Enter the hauler's name.");
  const { error } = await supabase.rpc("hauler_save", {
    p_id: id(f, "id"), p_name: name, p_contact_name: text(f, "contact_name"), p_phone: text(f, "phone"), p_email: text(f, "email"), p_notes: text(f, "notes"), p_active: f.get("active") !== "off",
  });
  if (error) back(dbErrorMessage(error));
  done("hauler");
}

export async function addHaulerTruck(f: FormData) {
  const supabase = await db("fleet.edit");
  const hauler = id(f, "hauler_id");
  const unit = text(f, "unit_number");
  const type = text(f, "truck_type");
  if (!hauler || !unit) back("Enter the truck's unit number.");
  if (!(TRUCK_TYPES as string[]).includes(type)) back("Choose the truck type.");
  const { error } = await supabase.rpc("hauler_add_truck", { p_hauler: hauler, p_unit: unit, p_type: type, p_plate: text(f, "plate") });
  if (error) back(dbErrorMessage(error));
  done("truck");
}

export async function addHaulerDriver(f: FormData) {
  const supabase = await db("fleet.edit");
  const hauler = id(f, "hauler_id");
  const name = text(f, "name");
  if (!hauler || !name) back("Enter the driver's name.");
  const { error } = await supabase.rpc("hauler_add_driver", { p_hauler: hauler, p_name: name, p_phone: text(f, "phone") });
  if (error) back(dbErrorMessage(error));
  done("driver");
}

export async function recordHaulerDocument(f: FormData) {
  const supabase = await db("fleet.edit");
  const hauler = id(f, "hauler_id");
  const kind = text(f, "kind") as DocKind;
  if (!hauler || !(DOC_KINDS as readonly string[]).includes(kind)) back("Choose the document.");
  const truck = id(f, "truck_id");
  if (TRUCK_DOCS.includes(kind) && !truck) back("Choose the truck for a registration or inspection.");
  const expires = text(f, "expires_on");
  if (expires && !isOperationalDate(expires)) back("Enter a valid expiry date.");
  if (EXPIRY_REQUIRED.includes(kind) && !expires) back("This document needs its expiry date.");
  const { error } = await supabase.rpc("hauler_record_document", {
    p_hauler: hauler, p_truck: TRUCK_DOCS.includes(kind) ? truck : null, p_kind: kind, p_reference: text(f, "reference"), p_expires_on: expires || null,
  });
  if (error) back(dbErrorMessage(error));
  done("document");
}

export async function sendOffer(f: FormData) {
  const supabase = await db("dispatch.edit");
  const load = id(f, "load_id");
  const crew = text(f, "crew").split(":");
  const truck = uuid.safeParse(crew[0]).success ? crew[0] : null;
  const driver = uuid.safeParse(crew[1]).success ? crew[1] : null;
  const unit = text(f, "rate_unit");
  const rate = text(f, "rate");
  if (!load) back("Choose the load to offer.");
  if (!truck || !driver) back("Choose the hired truck and driver.");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(rate) || Number(rate) <= 0) back("Enter the rate in dollars, for example 95 or 12.50.");
  if (!(RATE_UNITS as readonly string[]).includes(unit)) back("Choose per ton, per load or per hour.");
  const { error } = await supabase.rpc("hauler_offer_send", {
    p_load: load, p_truck: truck, p_trailer: null, p_driver: driver, p_rate_cents: Math.round(Number(rate) * 100), p_rate_unit: unit, p_note: text(f, "note"),
  });
  if (error) back(dbErrorMessage(error));
  done("offer");
}

export async function confirmOffer(f: FormData) {
  const supabase = await db("dispatch.edit");
  const offer = id(f, "offer_id");
  if (!offer) back("Offer not found.");
  const { error } = await supabase.rpc("hauler_offer_confirm", { p_offer: offer });
  if (error) back(dbErrorMessage(error));
  done("confirmed");
}

export async function withdrawOffer(f: FormData) {
  const supabase = await db("dispatch.edit");
  const offer = id(f, "offer_id");
  if (!offer) back("Offer not found.");
  const { error } = await supabase.rpc("hauler_offer_withdraw", { p_offer: offer, p_note: text(f, "note") });
  if (error) back(dbErrorMessage(error));
  done("withdrawn");
}

/** Dispatch records an answer the hauler gave by phone. */
export async function recordAnswer(f: FormData) {
  const supabase = await db("dispatch.edit");
  const offer = id(f, "offer_id");
  if (!offer) back("Offer not found.");
  const { error } = await supabase.rpc("hauler_offer_respond", { p_offer: offer, p_accept: text(f, "answer") === "accept", p_note: "Answered by phone" });
  if (error) back(dbErrorMessage(error));
  done("answered");
}

/** The hired driver answers their own offer on My Day. */
export async function answerMyOffer(f: FormData) {
  try {
    await assertPermission("driver.portal");
  } catch {
    back("Only the driver the offer was made to can answer it.", "/driver");
  }
  const supabase = await createClient();
  const offer = id(f, "offer_id");
  if (!offer) back("Offer not found.", "/driver");
  const { error } = await supabase.rpc("hauler_offer_respond", { p_offer: offer, p_accept: text(f, "answer") === "accept", p_note: text(f, "note") });
  if (error) back(dbErrorMessage(error), "/driver");
  revalidatePath("/driver");
  redirect(`/driver?saved=${text(f, "answer") === "accept" ? "offer_accepted" : "offer_declined"}`);
}
