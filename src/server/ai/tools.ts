import "server-only";
import type { z } from "zod";
import type { Permission } from "@/lib/permissions";
import type { JsonSchema, ToolDefinition } from "./types";

// Approved tools (docs/AI.md §8). A model can only ask for a tool; the server decides. Every call is checked here:
// the tool must be registered for the capability, its arguments must parse and validate (model output is untrusted),
// the signed-in person must hold its permission (from the session, never from the model), and its kind must be
// allowed. Kinds:
//   read     — reads the caller's own company data (through their session, so RLS applies) and returns it;
//   propose  — records a suggestion for a person to review; changes nothing;
//   execute  — a consequential action. Never run by the model loop: it becomes a pending approval that a person with
//              the permission must approve (executeApprovedTool), after which arguments and permission are re-checked.
// Company ids are never tool arguments: tools act only on data the server resolved for the caller's own company.

export type ToolKind = "read" | "propose" | "execute";
const RANK: Record<ToolKind, number> = { read: 0, propose: 1, execute: 2 };

export interface ToolContext<C> {
  permissions: readonly Permission[];
  /** Capability-specific, server-resolved data for this request (for example the plan being explained). */
  data: C;
}

export interface Tool<C, A = unknown> {
  name: string;
  description: string;
  kind: ToolKind;
  /** The permission it needs; a list means any one of them. */
  permission: Permission | readonly Permission[];
  parameters: JsonSchema;
  args: z.ZodType<A>;
  run: (args: A, ctx: ToolContext<C>) => Promise<unknown> | unknown;
}

export interface Proposal {
  tool: string;
  args: unknown;
  result: unknown;
}

export interface PendingApproval {
  tool: string;
  args: unknown;
}

export type ToolOutcome =
  | { status: "ok"; output: string; proposal?: Proposal }
  | { status: "refused"; output: string; reason: "unknown_tool" | "malformed" | "invalid" | "permission" | "kind" | "failed" }
  | { status: "needs_approval"; output: string; pending: PendingApproval };

const MAX_OUTPUT = 8000;

function allowed(tool: { permission: Permission | readonly Permission[] }, permissions: readonly Permission[]): boolean {
  return typeof tool.permission === "string" ? permissions.includes(tool.permission) : tool.permission.some((p) => permissions.includes(p));
}

/** The tools the person may use: the model is only offered these. */
export function toolsFor<C>(tools: Tool<C>[], permissions: readonly Permission[]): Tool<C>[] {
  return tools.filter((t) => allowed(t, permissions));
}

export function toolDefinitions<C>(tools: Tool<C>[]): ToolDefinition[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

function refuse(reason: Extract<ToolOutcome, { status: "refused" }>["reason"], message: string): ToolOutcome {
  return { status: "refused", reason, output: JSON.stringify({ error: message }) };
}

/** Run one model-requested tool call under the capability's ceiling (`maxKind`). Never throws for model mistakes. */
export async function runToolCall<C>(tools: Tool<C>[], call: { name: string; arguments: string }, ctx: ToolContext<C>, maxKind: ToolKind): Promise<ToolOutcome> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return refuse("unknown_tool", `There is no tool named ${call.name.slice(0, 60)}.`);
  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments);
  } catch {
    return refuse("malformed", "The arguments are not valid JSON.");
  }
  const parsed = tool.args.safeParse(raw);
  // Issue paths only: never echo the model's values back into logs or errors.
  if (!parsed.success) return refuse("invalid", `Invalid arguments: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}.`);
  if (!allowed(tool, ctx.permissions)) return refuse("permission", "The signed-in person is not allowed to use this tool.");
  if (tool.kind === "execute") {
    return { status: "needs_approval", output: JSON.stringify({ status: "needs_approval", note: "Recorded for a person to approve. Nothing was done." }), pending: { tool: tool.name, args: parsed.data } };
  }
  if (RANK[tool.kind] > RANK[maxKind]) return refuse("kind", "This capability may not use that tool.");
  try {
    const result = await tool.run(parsed.data, ctx);
    const output = JSON.stringify(result ?? null);
    if (output.length > MAX_OUTPUT) return refuse("failed", "The tool result was too large.");
    return tool.kind === "propose" ? { status: "ok", output, proposal: { tool: tool.name, args: parsed.data, result } } : { status: "ok", output };
  } catch {
    return refuse("failed", "The tool could not complete.");
  }
}

/**
 * Run a consequential tool after a person approved it. Requires an `execute` tool, an approver who holds its
 * permission in their own session, and arguments that validate again now (the pending approval came from a model).
 */
export async function executeApprovedTool<C>(tools: Tool<C>[], pending: PendingApproval, approver: ToolContext<C>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const tool = tools.find((t) => t.name === pending.tool);
  if (!tool || tool.kind !== "execute") return { ok: false, error: "That action cannot be approved." };
  if (!allowed(tool, approver.permissions)) return { ok: false, error: "You are not allowed to approve this action." };
  const parsed = tool.args.safeParse(pending.args);
  if (!parsed.success) return { ok: false, error: "The action's details are no longer valid." };
  return { ok: true, result: await tool.run(parsed.data, approver) };
}
