// Provider-independent AI interfaces (docs/AI.md). Application code talks to these types only; everything specific to a
// provider (request format, response shape, errors, usage metadata, tool-call encoding) stays inside its adapter.

/** Why an AI operation did not produce a usable result. Only `rate_limit`, `timeout` and `provider` may be retried. */
export type AiErrorKind =
  | "not_configured" // no provider, key, model or capability switch
  | "disabled" // the capability's readiness gate is closed (evaluation, budget, demo, permission)
  | "budget" // the company's monthly token or estimated cost cap is reached
  | "user_limit" // the person's own per-minute, daily or monthly limit is reached
  | "too_large" // the request would exceed the maximum request size (never sent)
  | "auth" // the provider refused the credentials
  | "rate_limit"
  | "timeout"
  | "provider" // provider-side failure (5xx, malformed response)
  | "bad_request" // the provider refused the request as invalid (our bug; never retried)
  | "invalid_output" // the model's answer failed validation or grounding checks
  | "tool" // a tool call was refused (validation, permission, kind)
  | "sensitive_data"; // the request would have sent data that must stay on the server (never sent)

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp";

/** A JSON Schema object (the subset providers accept for structured outputs and tool parameters). */
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  /** Strict JSON schema: every property required, additionalProperties false. */
  parameters: JsonSchema;
}

/** One turn of a conversation in provider-neutral form. */
export type ConversationItem =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  /** An image from the person's own records (a ticket photo), sent only by capabilities whose gate allows images. */
  | { kind: "image"; mediaType: ImageMediaType; base64: string }
  | { kind: "tool_call"; callId: string; name: string; arguments: string }
  | { kind: "tool_result"; callId: string; output: string };

export interface CompletionRequest {
  model: string;
  /** System-level instructions for this capability. */
  instructions: string;
  input: ConversationItem[];
  tools?: ToolDefinition[];
  /** When set, the final answer must be JSON matching this schema. */
  output?: { name: string; schema: JsonSchema };
  maxOutputTokens: number;
}

export interface ProviderUsage {
  /** As reported by the provider; null when the provider did not report it. */
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CompletionResponse {
  /** The provider's response id (for support and audit); never shown to customers. */
  id: string | null;
  /** The model that actually answered, as reported by the provider. */
  model: string;
  /** Final text (JSON when `output` was requested); null when the model called tools instead. */
  text: string | null;
  toolCalls: Array<{ callId: string; name: string; arguments: string }>;
  usage: ProviderUsage;
  /** The model declined to answer. */
  refusal: string | null;
}

export interface ProviderCapabilities {
  structuredOutputs: boolean;
  toolCalls: boolean;
}

export interface AiProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: CompletionRequest, opts: { timeoutMs: number }): Promise<CompletionResponse>;
}

/**
 * What a person is told when an AI request fails: a fixed sentence per kind. Provider failures never pass on provider
 * text (it can quote part of a key or the request); limit and validation messages are Taviron's own wording.
 */
export function publicMessage(e: AiError): string {
  switch (e.kind) {
    case "auth":
    case "bad_request":
    case "provider":
    case "not_configured":
      return "The AI service is not available right now. Nothing was changed.";
    case "timeout":
    case "rate_limit":
      return e.message.startsWith("Too many AI requests") ? e.message : "The AI service is busy. Try again in a minute.";
    case "invalid_output":
      return "The answer did not pass Taviron's checks, so it is not shown. Try asking in a different way.";
    case "sensitive_data":
      return "The question would have sent private details to the AI service, so nothing was sent.";
    case "tool":
      return "The answer needed information you do not have access to.";
    default:
      return e.message; // disabled, budget, user_limit, too_large: Taviron's own messages
  }
}
