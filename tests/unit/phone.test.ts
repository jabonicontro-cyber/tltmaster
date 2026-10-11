import { describe, expect, it } from "vitest";
import { backspaceOverFormatting, caretAfterFormat, formatPhone, isCompletePhone } from "@/lib/phone";
import { optionalPhone } from "@/lib/schemas/common";

/** Simulate typing characters one by one at the end. */
const typeIn = (chars: string) => Array.from(chars).reduce((v, c) => formatPhone(v + c), "");

describe("progressive US phone formatting", () => {
  it("formats as the digits arrive", () => {
    expect(typeIn("1")).toBe("1");
    expect(typeIn("123")).toBe("123");
    expect(typeIn("1234")).toBe("(123) 4");
    expect(typeIn("1234567")).toBe("(123) 456-7");
    expect(typeIn("1234567890")).toBe("(123) 456-7890");
  });

  it("formats pasted numbers in any common shape", () => {
    for (const v of ["1234567890", "123-456-7890", "123.456.7890", "(123)456-7890", " 123 456 7890 "]) expect(formatPhone(v)).toBe("(123) 456-7890");
    expect(formatPhone("1 (234) 567-8901")).toBe("+1 (234) 567-8901");
    expect(formatPhone("12345678901")).toBe("+1 (234) 567-8901");
  });

  it("keeps extensions and international numbers", () => {
    expect(formatPhone("1234567890 x12")).toBe("(123) 456-7890 x12");
    expect(formatPhone("123 456 7890 ext. 7")).toBe("(123) 456-7890 x7");
    expect(formatPhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(formatPhone("+44 20++7946 abc")).toBe("+44 207946 "); // stray "+" and letters dropped
  });

  it("never mangles long non-US digit strings and is idempotent", () => {
    expect(formatPhone("0044207946095812")).toBe("004420794609581");
    for (const v of ["1", "(123) 4", "(123) 456-7890", "+1 (234) 567-8901", "(123) 456-7890 x12", "+44 20 7946 0958"]) expect(formatPhone(formatPhone(v))).toBe(formatPhone(v));
  });

  it("produces values the server accepts, and flags incomplete ones", () => {
    for (const v of ["(123) 456-7890", "+1 (234) 567-8901", "(123) 456-7890 x12", "+44 20 7946 0958"]) {
      expect(optionalPhone.safeParse(formatPhone(v)).success, v).toBe(true);
      expect(isCompletePhone(formatPhone(v)), v).toBe(true);
    }
    expect(isCompletePhone("(123) 4")).toBe(false);
    expect(isCompletePhone("")).toBe(true);
  });
});

describe("caret and editing", () => {
  it("keeps the caret after the same digit when editing in the middle", () => {
    // "(312) 456-789" with "9" typed after "45": raw "(312) 4596-789", caret after the 9 (index 9).
    const raw = "(312) 4596-789";
    const formatted = formatPhone(raw);
    expect(formatted).toBe("(312) 459-6789");
    expect(formatted.slice(0, caretAfterFormat(raw, 9, formatted))).toBe("(312) 459");
  });

  it("puts the caret at the end while typing at the end", () => {
    const raw = "(123) 4";
    expect(caretAfterFormat("1234", 4, raw)).toBe(raw.length);
  });

  it("backspace after a formatting character deletes the digit before it", () => {
    // Caret right after ") " in "(123) 4": deleting should remove the 3, not get stuck.
    const r = backspaceOverFormatting("(123) 4", 6);
    expect(r).toEqual({ value: "(124", caret: 3 });
    expect(formatPhone(r!.value)).toBe("124");
    expect(backspaceOverFormatting("(123) 456-7", 9)).toBeNull(); // after a digit: normal backspace
    expect(backspaceOverFormatting("+44 20", 4)).toBeNull(); // international: browser handles it
  });
});
