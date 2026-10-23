// Reasoning models (OpenAI's gpt-5 and o-series) spend hidden reasoning tokens before they answer, and those count
// against max_output_tokens. With only the answer's budget as the cap, every answer was cut off in the first live
// evaluation (gpt-5-mini, 2026-10-23). For these models the adapter asks for low reasoning effort and the cap gets a
// fixed allowance on top of the answer's budget; the budget checks use the same cap, so the monthly token limit still
// bounds the worst case. Pure: shared by the provider adapter and the run loop.

export const REASONING_ALLOWANCE = 3000;
export const REASONING_EFFORT = "low";

export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model);
}

/** max_output_tokens for a request whose answer needs `answerTokens`. */
export function outputTokenCap(model: string, answerTokens: number): number {
  return isReasoningModel(model) ? answerTokens + REASONING_ALLOWANCE : answerTokens;
}
