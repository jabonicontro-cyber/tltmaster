/**
 * Driver earnings formula engine (master plan B27; owner directives 2026-10-18). Each company writes its own formula;
 * Taviron has no built-in pay rule. Safety and honesty rules:
 *
 * - Only an explicit list of inputs and operators: numbers, the variables below, + - * / ( ) and min(), max(),
 *   if(condition, then, else) with comparisons. Nothing else is parsed, and nothing is ever executed as code.
 * - Exact decimal arithmetic (no floating point): every value is a BigInt scaled by 10^6; the result is rounded once,
 *   half away from zero, to whole cents.
 * - A missing input never becomes 0: the calculation stops and names what is missing (a review exception).
 * - Customer billing figures are inputs only when a formula names them explicitly (billed_amount); pay never follows
 *   billing by default.
 * - Every evaluation returns a breakdown a reviewer can read.
 */

export const PAY_VARIABLES = {
  quantity: "Delivered quantity on the verified ticket, in the ticket's unit",
  tons: "Delivered tons (only when the ticket's unit is tons)",
  loads: "Loads on the ticket (1 per ticket)",
  rate: "The rate configured on the pay rule",
  hours: "Hours recorded for the work (only when the company records them)",
  billed_amount: "The customer billing amount for the ticket's line (only if a formula names it explicitly)",
  driver_share: "This driver's share of a shared delivery (0 to 1, from the configured allocation)",
} as const;
export type PayVariable = keyof typeof PAY_VARIABLES;

const SCALE = BigInt(1_000_000);
const FUNCTIONS = new Set(["min", "max", "if"]);

type Token =
  | { t: "num"; v: bigint; text: string }
  | { t: "var"; v: PayVariable }
  | { t: "fn"; v: "min" | "max" | "if" }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "<" | "<=" | ">" | ">=" | "==" | "!=" }
  | { t: "("; } | { t: ")" } | { t: "," };

export type Expr =
  | { k: "num"; v: bigint; text: string }
  | { k: "var"; v: PayVariable }
  | { k: "neg"; e: Expr }
  | { k: "bin"; op: "+" | "-" | "*" | "/"; a: Expr; b: Expr }
  | { k: "cmp"; op: "<" | "<=" | ">" | ">=" | "==" | "!="; a: Expr; b: Expr }
  | { k: "call"; fn: "min" | "max" | "if"; args: Expr[] };

export class FormulaError extends Error {}

/** Parse a decimal literal exactly ("12.5" → BigInt(12_500_000) at scale 10^6). At most 6 decimals. */
export function parseDecimal(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) throw new FormulaError(`"${text}" is not a number Taviron can use (at most 6 decimal places).`);
  return BigInt(m[1]) * SCALE + BigInt((m[2] ?? "").padEnd(6, "0"));
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: "num", v: parseDecimal(num[0]), text: num[0] }); i += num[0].length; continue; }
    const word = /^[a-z_]+/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      if (FUNCTIONS.has(w)) out.push({ t: "fn", v: w as "min" | "max" | "if" });
      else if (Object.hasOwn(PAY_VARIABLES, w)) out.push({ t: "var", v: w as PayVariable });
      else throw new FormulaError(`"${w}" is not a supported input. Use: ${Object.keys(PAY_VARIABLES).join(", ")}.`);
      i += w.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "==", "!="].includes(two)) { out.push({ t: "op", v: two as "<=" }); i += 2; continue; }
    if ("+-*/<>".includes(c)) { out.push({ t: "op", v: c as "+" }); i++; continue; }
    if (c === "(" || c === ")" || c === ",") { out.push({ t: c } as Token); i++; continue; }
    throw new FormulaError(`"${c}" is not allowed in a pay formula.`);
  }
  return out;
}

/** Parse a formula into an expression tree, or throw a FormulaError explaining the problem. */
export function parseFormula(src: string): Expr {
  if (src.length > 500) throw new FormulaError("Keep the formula under 500 characters.");
  const toks = tokenize(src);
  if (!toks.length) throw new FormulaError("Enter a formula.");
  let p = 0;
  const peek = () => toks[p];
  const take = () => toks[p++];
  const expect = (t: Token["t"]) => {
    const k = take();
    if (!k || k.t !== t) throw new FormulaError(`Expected "${t}" in the formula.`);
  };
  const comparison = (): Expr => {
    const a = additive();
    const n = peek();
    if (n && n.t === "op" && ["<", "<=", ">", ">=", "==", "!="].includes(n.v)) {
      take();
      return { k: "cmp", op: n.v as "<", a, b: additive() };
    }
    return a;
  };
  const additive = (): Expr => {
    let e = term();
    for (let n = peek(); n && n.t === "op" && (n.v === "+" || n.v === "-"); n = peek()) {
      take();
      e = { k: "bin", op: n.v, a: e, b: term() };
    }
    return e;
  };
  const term = (): Expr => {
    let e = unary();
    for (let n = peek(); n && n.t === "op" && (n.v === "*" || n.v === "/"); n = peek()) {
      take();
      e = { k: "bin", op: n.v, a: e, b: unary() };
    }
    return e;
  };
  const unary = (): Expr => {
    const n = peek();
    if (n && n.t === "op" && n.v === "-") { take(); return { k: "neg", e: unary() }; }
    return primary();
  };
  const primary = (): Expr => {
    const n = take();
    if (!n) throw new FormulaError("The formula ends too early.");
    if (n.t === "num") return { k: "num", v: n.v, text: n.text };
    if (n.t === "var") return { k: "var", v: n.v };
    if (n.t === "(") { const e = comparison(); expect(")"); return e; }
    if (n.t === "fn") {
      expect("(");
      const args = [comparison()];
      while (peek()?.t === ",") { take(); args.push(comparison()); }
      expect(")");
      if (n.v === "if" && args.length !== 3) throw new FormulaError("if() needs three parts: if(condition, value, otherwise).");
      if (n.v !== "if" && args.length < 2) throw new FormulaError(`${n.v}() needs at least two values.`);
      return { k: "call", fn: n.v, args };
    }
    throw new FormulaError("The formula has an operator where a value is expected.");
  };
  const e = comparison();
  if (p < toks.length) throw new FormulaError("The formula has extra text at the end.");
  if (e.k === "cmp") throw new FormulaError("The formula must produce an amount, not a yes/no comparison.");
  return e;
}

/** The inputs a formula reads (so missing ones can be reported before anything is calculated). */
export function formulaVariables(e: Expr): PayVariable[] {
  const out = new Set<PayVariable>();
  const walk = (x: Expr) => {
    if (x.k === "var") out.add(x.v);
    else if (x.k === "neg") walk(x.e);
    else if (x.k === "bin" || x.k === "cmp") { walk(x.a); walk(x.b); }
    else if (x.k === "call") x.args.forEach(walk);
  };
  walk(e);
  return [...out];
}

export interface FormulaCheck { ok: boolean; error?: string; variables: PayVariable[]; usesBilling: boolean }

export function validateFormula(src: string): FormulaCheck {
  try {
    const vars = formulaVariables(parseFormula(src));
    return { ok: true, variables: vars, usesBilling: vars.includes("billed_amount") };
  } catch (e) {
    return { ok: false, error: e instanceof FormulaError ? e.message : "The formula could not be read.", variables: [], usesBilling: false };
  }
}

export type PayInputs = Partial<Record<PayVariable, string | null>>;

export type Evaluation =
  | { ok: true; cents: bigint; exact: string; breakdown: string }
  | { ok: false; reason: "missing_input"; missing: PayVariable[] }
  | { ok: false; reason: "invalid"; error: string };

const fmt = (v: bigint) => {
  const neg = v < BigInt(0);
  const a = neg ? -v : v;
  const whole = a / SCALE;
  const frac = (a % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
};

/** Round a scaled value to whole cents, half away from zero. */
export function toCents(v: bigint): bigint {
  const perCent = SCALE / BigInt(100); // 10_000
  const neg = v < BigInt(0);
  const a = neg ? -v : v;
  const cents = (a + perCent / BigInt(2)) / perCent;
  return neg ? -cents : cents;
}

/**
 * Evaluate a formula against one ticket's inputs. Input values are decimal strings (exact); a null or absent input that
 * the formula reads stops the calculation and is reported, never treated as 0.
 */
export function evaluateFormula(src: string, inputs: PayInputs): Evaluation {
  let expr: Expr;
  try {
    expr = parseFormula(src);
  } catch (e) {
    return { ok: false, reason: "invalid", error: e instanceof FormulaError ? e.message : "The formula could not be read." };
  }
  const missing = formulaVariables(expr).filter((v) => inputs[v] === null || inputs[v] === undefined || inputs[v] === "");
  if (missing.length) return { ok: false, reason: "missing_input", missing };
  const values = new Map<PayVariable, bigint>();
  try {
    for (const v of formulaVariables(expr)) {
      const raw = String(inputs[v]).trim();
      const neg = raw.startsWith("-");
      const val = parseDecimal(neg ? raw.slice(1) : raw);
      values.set(v, neg ? -val : val);
    }
  } catch (e) {
    return { ok: false, reason: "invalid", error: e instanceof FormulaError ? e.message : "An input is not a number." };
  }
  const show = (x: Expr): string => {
    switch (x.k) {
      case "num": return x.text;
      case "var": return `${x.v} (${fmt(values.get(x.v)!)})`;
      case "neg": return `-${show(x.e)}`;
      case "bin": return `(${show(x.a)} ${x.op} ${show(x.b)})`;
      case "cmp": return `${show(x.a)} ${x.op} ${show(x.b)}`;
      case "call": return `${x.fn}(${x.args.map(show).join(", ")})`;
    }
  };
  const ev = (x: Expr): bigint => {
    switch (x.k) {
      case "num": return x.v;
      case "var": return values.get(x.v)!;
      case "neg": return -ev(x.e);
      case "bin": {
        const a = ev(x.a);
        const b = ev(x.b);
        if (x.op === "+") return a + b;
        if (x.op === "-") return a - b;
        if (x.op === "*") return (a * b) / SCALE;
        if (b === BigInt(0)) throw new FormulaError("The formula divides by zero for this ticket.");
        return (a * SCALE) / b;
      }
      case "cmp": {
        const a = ev(x.a);
        const b = ev(x.b);
        const r = x.op === "<" ? a < b : x.op === "<=" ? a <= b : x.op === ">" ? a > b : x.op === ">=" ? a >= b : x.op === "==" ? a === b : a !== b;
        return r ? SCALE : BigInt(0);
      }
      case "call": {
        if (x.fn === "if") return ev(x.args[0]) !== BigInt(0) ? ev(x.args[1]) : ev(x.args[2]);
        const vals = x.args.map(ev);
        return vals.reduce((m, v) => (x.fn === "min" ? (v < m ? v : m) : v > m ? v : m));
      }
    }
  };
  try {
    const exact = ev(expr);
    const cents = toCents(exact);
    return { ok: true, cents, exact: fmt(exact), breakdown: `${show(expr)} = ${fmt(exact)} → ${fmt(cents * BigInt(10_000))}` };
  } catch (e) {
    return { ok: false, reason: "invalid", error: e instanceof FormulaError ? e.message : "The formula could not be calculated." };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Rule selection
// ---------------------------------------------------------------------------------------------------------------------

export const RULE_DIMENSIONS = ["driver_id", "customer_id", "order_id", "material_id", "truck_id"] as const;
export type RuleDimension = (typeof RULE_DIMENSIONS)[number];

export interface PayRuleVersion {
  id: string;
  rule_id: string;
  name: string;
  status: "draft" | "active" | "retired";
  effective_from: string;
  effective_to: string | null;
  formula: string;
  rate: string | null;
  unit_code: string | null;
  scope: Partial<Record<RuleDimension, string>>;
}

export interface TicketFacts {
  delivered_on: string;
  unit_code: string;
  driver_id: string | null;
  customer_id: string | null;
  order_id: string | null;
  material_id: string | null;
  truck_id: string | null;
}

export type RuleSelection =
  | { ok: true; rule: PayRuleVersion }
  | { ok: false; reason: "no_rule" }
  | { ok: false; reason: "conflict"; rules: PayRuleVersion[] };

/**
 * The active rule version that applies to a ticket: in effect on the delivery date, for the ticket's unit (when the rule
 * names one), and matching every dimension the rule is scoped to. The most specific rule (most matching dimensions)
 * wins; two equally specific rules are a conflict for review — never an arbitrary choice.
 */
export function selectRule(rules: readonly PayRuleVersion[], t: TicketFacts): RuleSelection {
  const candidates = rules.filter((r) =>
    r.status === "active" &&
    r.effective_from <= t.delivered_on &&
    (r.effective_to === null || r.effective_to >= t.delivered_on) &&
    (!r.unit_code || r.unit_code === t.unit_code) &&
    RULE_DIMENSIONS.every((d) => !r.scope[d] || r.scope[d] === t[d]));
  if (!candidates.length) return { ok: false, reason: "no_rule" };
  const specificity = (r: PayRuleVersion) => RULE_DIMENSIONS.filter((d) => r.scope[d]).length + (r.unit_code ? 0.5 : 0);
  const best = Math.max(...candidates.map(specificity));
  const top = candidates.filter((r) => specificity(r) === best);
  return top.length === 1 ? { ok: true, rule: top[0] } : { ok: false, reason: "conflict", rules: top };
}

/** Rules for the same scope whose effective periods overlap (blocked when activating a rule version). */
export function overlappingRules(rules: readonly PayRuleVersion[], candidate: PayRuleVersion): PayRuleVersion[] {
  const end = (r: PayRuleVersion) => r.effective_to ?? "9999-12-31";
  return rules.filter((r) =>
    r.id !== candidate.id && r.status === "active" &&
    (r.unit_code ?? "") === (candidate.unit_code ?? "") &&
    RULE_DIMENSIONS.every((d) => (r.scope[d] ?? "") === (candidate.scope[d] ?? "")) &&
    r.effective_from <= end(candidate) && candidate.effective_from <= end(r));
}
