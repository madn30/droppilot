import Anthropic from "@anthropic-ai/sdk";

// Claude Opus 5.5. Thinking is always on for this model; effort controls depth.
export const ANTHROPIC_MODEL = "claude-opus-5-5";

/** Structured replies are small, but max_tokens also has to cover the model's thinking. */
export const MAX_TOKENS = 8000;

export function createAnthropicClient(apiKey: string, fetchImpl?: typeof fetch): Anthropic {
  return new Anthropic({ apiKey, fetch: fetchImpl });
}

/** A reply we cannot use: the model declined, ran out of tokens, or returned no parsable output. */
export class AnthropicOutputError extends Error {
  constructor(task: string, reason: string) {
    super(`Claude returned no usable ${task}: ${reason}`);
    this.name = "AnthropicOutputError";
  }
}

/** Returns the parsed output of a structured reply, or explains why there is none. */
export function requireParsedOutput<T>(
  task: string,
  message: { stop_reason: string | null; parsed_output: T | null },
): T {
  if (message.stop_reason === "refusal") throw new AnthropicOutputError(task, "the request was declined");
  if (message.stop_reason === "max_tokens") throw new AnthropicOutputError(task, "the reply was cut off at max_tokens");
  if (message.parsed_output === null) throw new AnthropicOutputError(task, "the reply did not match the schema");
  return message.parsed_output;
}
