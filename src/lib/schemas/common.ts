import { z } from "zod";

export const trimmed = (max: number) => z.string().trim().max(max, `Maximum ${max} characters.`);

export const optionalText = (max: number) => trimmed(max).default("");

export const requiredText = (max: number, label: string) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `Maximum ${max} characters.`);

export const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .default("")
  .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email address.");

export const optionalPhone = z
  .string()
  .trim()
  .max(40)
  .default("")
  .refine((v) => v === "" || /^[0-9+().\-\s]{7,40}( ?(x|ext\.?) ?\d{1,6})?$/i.test(v), "Enter a valid phone number.");

export const stateCode = z
  .string()
  .trim()
  .toUpperCase()
  .default("IN")
  .refine((v) => v === "" || /^[A-Z]{2}$/.test(v), "Use the 2-letter state code.");

export const postalCode = z
  .string()
  .trim()
  .default("")
  .refine((v) => v === "" || /^\d{5}(-\d{4})?$/.test(v), "Enter a 5-digit ZIP code.");

export const checkbox = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());

export const uuid = z.uuid("Invalid identifier.");
