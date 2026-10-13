import "server-only";
import { AiError, type AiProvider, type CompletionRequest, type CompletionResponse, type ConversationItem } from "./types";

// OpenAI adapter (Responses API, https://platform.openai.com/docs/api-reference/responses). Everything OpenAI-specific
// lives here: request and response shapes, function-call encoding, structured outputs, error mapping and usage
// metadata. Requests are sent with `store: false` so OpenAI does not keep them for later retrieval.

const ENDPOINT = "https://api.openai.com/v1/responses";

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

/** Map an HTTP failure to an error kind; never includes the request body or the key in the message. */
function classify(status: number, body: string): AiError {
  let detail = "";
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    /* not JSON */
  }
  const tail = detail ? ` (${detail.slice(0, 200)})` : "";
  if (status === 401 || status === 403) return new AiError("auth", `OpenAI refused the API key or project access${tail}.`);
  if (status === 429) return new AiError("rate_limit", `OpenAI rate limit or quota reached${tail}.`, true);
  if (status === 400 || status === 404 || status === 422) return new AiError("bad_request", `OpenAI refused the request${tail}.`);
  if (status >= 500) return new AiError("provider", `OpenAI is unavailable (HTTP ${status}).`, true);
  return new AiError("provider", `Unexpected response from OpenAI (HTTP ${status}).`);
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  // Verified against the Responses API: JSON-schema structured outputs and function calling are both supported. Whether
  // a particular model supports them is checked by that capability's evaluation run, not assumed here.
  readonly capabilities = { structuredOutputs: true, toolCalls: true };

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly retryDelayMs = 1200,
  ) {}

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
      max_output_tokens: request.maxOutputTokens,
      store: false,
    };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true }));
    }
    if (request.output) {
      body.text = { format: { type: "json_schema", name: request.output.name, schema: request.output.schema, strict: true } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") throw new AiError("timeout", `OpenAI did not answer within ${Math.round(timeoutMs / 1000)} s.`, true);
      throw new AiError("provider", "Could not reach OpenAI.", true);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw classify(res.status, text);
    let data: OpenAiResponse;
    try {
      data = JSON.parse(text) as OpenAiResponse;
    } catch {
      throw new AiError("provider", "OpenAI returned a response that is not JSON.", true);
    }
    if (data.status === "failed" || data.error) throw new AiError("provider", `OpenAI could not complete the request${data.error?.message ? ` (${data.error.message.slice(0, 200)})` : ""}.`);
    if (data.status === "incomplete") throw new AiError("invalid_output", `The answer was cut off (${data.incomplete_details?.reason ?? "incomplete"}).`);

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
