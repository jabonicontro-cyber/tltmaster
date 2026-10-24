import "server-only";
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { AiError, type AiProvider, type CompletionRequest, type CompletionResponse, type ConversationItem } from "./types";
import { isReasoningModel, outputTokenCap, REASONING_EFFORT } from "@/lib/ai/reasoning";

// OpenAI adapter on the official SDK (`openai`, Responses API). Everything OpenAI-specific lives here: request and
// response shapes, function-call encoding, structured outputs, error mapping and usage metadata. Requests are sent with
// `store: false` so OpenAI does not keep them for later retrieval.
//
// The key is passed in by the server (src/server/ai/gates.ts) and never read from the environment here, never logged
// and never put in an error message: provider error text is not passed on (it can quote part of a key), only a fixed
// message per kind. The SDK's own retries and logging are off; this adapter retries once, itself, below.

type OpenAiItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

function toItem(i: ConversationItem): OpenAiItem {
  if (i.kind === "message") return { role: i.role, content: i.text };
  if (i.kind === "tool_call") return { type: "function_call", call_id: i.callId, name: i.name, arguments: i.arguments };
  return { type: "function_call_output", call_id: i.callId, output: i.output };
}

interface OpenAiResponse {
  id?: string;
  model?: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

/** Map an SDK failure to an error kind with a fixed message (no provider text, no request content, no key). */
export function classifyOpenAiError(e: unknown, timeoutMs: number): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof APIConnectionTimeoutError) return new AiError("timeout", `OpenAI did not answer within ${Math.round(timeoutMs / 1000)} s.`, true);
  if (e instanceof APIUserAbortError) return new AiError("timeout", `OpenAI did not answer within ${Math.round(timeoutMs / 1000)} s.`, true);
  if (e instanceof APIConnectionError) return new AiError("provider", "Could not reach OpenAI.", true);
  if (e instanceof APIError) {
    const status = e.status ?? 0;
    if (status === 401 || status === 403) return new AiError("auth", "OpenAI refused the API key or project access.");
    if (status === 429) return new AiError("rate_limit", "OpenAI rate limit or quota reached.", true);
    if (status === 400 || status === 404 || status === 409 || status === 422) return new AiError("bad_request", `OpenAI refused the request (HTTP ${status}).`);
    if (status >= 500) return new AiError("provider", `OpenAI is unavailable (HTTP ${status}).`, true);
    return new AiError("provider", `Unexpected response from OpenAI (HTTP ${status || "unknown"}).`);
  }
  if ((e as { name?: string } | null)?.name === "AbortError") return new AiError("timeout", `OpenAI did not answer within ${Math.round(timeoutMs / 1000)} s.`, true);
  return new AiError("provider", "OpenAI returned a response that could not be read.", true);
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  // Verified against the Responses API: JSON-schema structured outputs and function calling are both supported. Whether
  // a particular model supports them is checked by that capability's evaluation run, not assumed here.
  readonly capabilities = { structuredOutputs: true, toolCalls: true };
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    fetchImpl?: typeof fetch,
    private readonly retryDelayMs = 1200,
  ) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      logLevel: "off",
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }

  async complete(request: CompletionRequest, opts: { timeoutMs: number }): Promise<CompletionResponse> {
    try {
      return await this.attempt(request, opts.timeoutMs);
    } catch (e) {
      // One bounded retry for transient failures only (rate limit, timeout, 5xx). Never for auth, bad requests or
      // invalid output; never more than once, so a failing provider cannot cause a retry storm or runaway spend.
      if (!(e instanceof AiError) || !e.retryable) throw e;
      await new Promise((r) => setTimeout(r, this.retryDelayMs));
      return this.attempt(request, opts.timeoutMs);
    }
  }

  private async attempt(request: CompletionRequest, timeoutMs: number): Promise<CompletionResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      instructions: request.instructions,
      input: request.input.map(toItem),
      max_output_tokens: outputTokenCap(request.model, request.maxOutputTokens),
      store: false,
    };
    if (isReasoningModel(request.model)) body.reasoning = { effort: REASONING_EFFORT };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true }));
    }
    if (request.output) {
      body.text = { format: { type: "json_schema", name: request.output.name, schema: request.output.schema, strict: true } };
    }

    let raw: unknown;
    try {
      raw = await this.client.responses.create(body as unknown as OpenAI.Responses.ResponseCreateParamsNonStreaming, { timeout: timeoutMs, maxRetries: 0 });
    } catch (e) {
      throw classifyOpenAiError(e, timeoutMs);
    }
    if (!raw || typeof raw !== "object") throw new AiError("provider", "OpenAI returned a response that is not JSON.", true);
    const data = raw as OpenAiResponse;
    if (data.status === "failed" || data.error) throw new AiError("provider", "OpenAI could not complete the request.");
    if (data.status === "incomplete") throw new AiError("invalid_output", `The answer was cut off (${data.incomplete_details?.reason === "max_output_tokens" ? "output limit" : "incomplete"}).`);

    const toolCalls: CompletionResponse["toolCalls"] = [];
    const texts: string[] = [];
    let refusal: string | null = null;
    for (const item of data.output ?? []) {
      if (item.type === "function_call" && item.call_id && item.name) toolCalls.push({ callId: item.call_id, name: item.name, arguments: item.arguments ?? "{}" });
      if (item.type === "message") {
        for (const c of item.content ?? []) {
          if (c.type === "output_text" && typeof c.text === "string") texts.push(c.text);
          if (c.type === "refusal" && c.refusal) refusal = c.refusal;
        }
      }
    }
    return {
      id: data.id ?? null,
      model: data.model ?? request.model,
      text: toolCalls.length ? null : texts.join("") || null,
      toolCalls,
      usage: { inputTokens: data.usage?.input_tokens ?? null, outputTokens: data.usage?.output_tokens ?? null },
      refusal,
    };
  }
}
