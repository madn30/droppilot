import { getEnv } from "../env";
import { AnthropicAspectFiller } from "./anthropic/aspect-filler";
import { createAnthropicClient } from "./anthropic/client";
import { AnthropicListingCopyGenerator } from "./anthropic/listing-copy";
import { AnthropicSpecExtractor } from "./anthropic/spec-extractor";
import { AnthropicVisionVerifier } from "./anthropic/vision-verifier";
import { ClaudeCliAspectFiller, ClaudeCliListingCopyGenerator, ClaudeCliSpecExtractor, ClaudeCliVisionVerifier } from "./claude-cli/providers";
import { JinaClipEmbeddings } from "./jina/clip-embeddings";
import { MockAspectFiller } from "./mock/mock-aspect-filler";
import { MockEmbeddingsProvider } from "./mock/mock-embeddings";
import { MockListingCopyGenerator } from "./mock/mock-listing-copy";
import { MockSpecExtractor } from "./mock/mock-spec-extractor";
import { MockVisionVerifier } from "./mock/mock-vision-verifier";
import type { AspectFiller, EmbeddingsProvider, ListingCopyGenerator, SpecExtractor, VisionVerifier } from "./types";

function requireKey(name: "ANTHROPIC_API_KEY" | "EMBEDDINGS_PROVIDER_KEY"): string {
  const value = getEnv()[name];
  if (!value) throw new Error(`${name} is required when MOCK_APIS=false`);
  return value;
}

function usesClaudeCli(): boolean {
  return getEnv().AI_PROVIDER === "claude-cli";
}

export function getSpecExtractor(): SpecExtractor {
  if (getEnv().MOCK_APIS) return new MockSpecExtractor();
  if (usesClaudeCli()) return new ClaudeCliSpecExtractor();
  return new AnthropicSpecExtractor(createAnthropicClient(requireKey("ANTHROPIC_API_KEY")));
}

export function getVisionVerifier(): VisionVerifier {
  if (getEnv().MOCK_APIS) return new MockVisionVerifier();
  if (usesClaudeCli()) return new ClaudeCliVisionVerifier();
  return new AnthropicVisionVerifier(createAnthropicClient(requireKey("ANTHROPIC_API_KEY")));
}

// The embeddings provider is pluggable: anything implementing EmbeddingsProvider can replace Jina here.
export function getEmbeddingsProvider(): EmbeddingsProvider {
  if (getEnv().MOCK_APIS) return new MockEmbeddingsProvider();
  return new JinaClipEmbeddings({ apiKey: requireKey("EMBEDDINGS_PROVIDER_KEY") });
}

export function getListingCopyGenerator(): ListingCopyGenerator {
  if (getEnv().MOCK_APIS) return new MockListingCopyGenerator();
  if (usesClaudeCli()) return new ClaudeCliListingCopyGenerator();
  return new AnthropicListingCopyGenerator(createAnthropicClient(requireKey("ANTHROPIC_API_KEY")));
}

export function getAspectFiller(): AspectFiller {
  if (getEnv().MOCK_APIS) return new MockAspectFiller();
  if (usesClaudeCli()) return new ClaudeCliAspectFiller();
  return new AnthropicAspectFiller(createAnthropicClient(requireKey("ANTHROPIC_API_KEY")));
}
