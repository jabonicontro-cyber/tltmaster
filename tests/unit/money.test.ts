import { describe, expect, it } from "vitest";
import {
  divRoundHalfAway,
  formatBp,
  formatCents,
  formatQuantity,
  parseMoneyToCents,
  parsePercentToBp,
  parseQuantityToMilli,
} from "@/lib/money";

describe("parseMoneyToCents", () => {
  it.each([
    ["12", 1200],
    ["12.5", 1250],
    ["12.05", 1205],
    ["$1,234.56", 123456],
    ["0.10", 10],
    ["  7.00 ", 700],
    ["-5", -500],
  ])("parses %s", (input, expected) => {
    expect(parseMoneyToCents(input)).toBe(expected);
  });

  it.each(["", "abc", "1.234", "1.2.3", "12a", "--1"])("rejects %s", (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });

  it("does not suffer from floating point error", () => {
    // 0.1 + 0.2 style problems: 19.99 * 100 in float is 1998.9999999999998
    expect(parseMoneyToCents("19.99")).toBe(1999);
    expect(parseMoneyToCents("1.15")).toBe(115);
  });
});

describe("parseQuantityToMilli", () => {
  it.each([
    ["1", 1000],
    ["12.5", 12500],
    ["0.001", 1],
    ["22.375", 22375],
    ["1,000", 1000000],
  ])("parses %s", (input, expected) => {
    expect(parseQuantityToMilli(input)).toBe(expected);
  });

  it.each(["", "-1", "1.2345", "x"])("rejects %s", (input) => {
    expect(parseQuantityToMilli(input)).toBeNull();
  });
});

describe("parsePercentToBp", () => {
  it.each([
    ["5", 500],
    ["5.25", 525],
    ["7%", 700],
    ["100", 10000],
  ])("parses %s", (input, expected) => {
    expect(parsePercentToBp(input)).toBe(expected);
  });
  it.each(["", "5.255", "-1", "abc"])("rejects %s", (input) => {
    expect(parsePercentToBp(input)).toBeNull();
  });
});

describe("formatting", () => {
  it("formats cents", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(-500)).toBe("-$5.00");
    expect(formatCents(1999, { symbol: false })).toBe("19.99");
  });
  it("formats quantities", () => {
    expect(formatQuantity(12500)).toBe("12.5");
    expect(formatQuantity(12000)).toBe("12");
    expect(formatQuantity(1234567)).toBe("1,234.567");
  });
  it("formats basis points", () => {
    expect(formatBp(525)).toBe("5.25%");
    expect(formatBp(700)).toBe("7%");
    expect(formatBp(50)).toBe("0.5%");
  });
});

describe("divRoundHalfAway", () => {
  it.each([
    [BigInt(5), BigInt(10), BigInt(1)],
    [BigInt(4), BigInt(10), BigInt(0)],
    [BigInt(15), BigInt(10), BigInt(2)],
    [BigInt(-15), BigInt(10), BigInt(-2)],
    [BigInt(-14), BigInt(10), BigInt(-1)],
    [BigInt(25), BigInt(10), BigInt(3)],
  ])("%s / %s = %s", (n, d, expected) => {
    expect(divRoundHalfAway(n, d)).toBe(expected);
  });
});
