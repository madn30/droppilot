import { describe, expect, it } from "vitest";
import { AnthropicOutputError, createAnthropicClient } from "./anthropic/client";
import { AnthropicListingCopyGenerator } from "./anthropic/listing-copy";
import { AnthropicSpecExtractor } from "./anthropic/spec-extractor";
import { AnthropicVisionVerifier } from "./anthropic/vision-verifier";
import { JinaClipEmbeddings } from "./jina/clip-embeddings";

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A Messages API reply whose single text block is the structured output. */
function anthropicReply(output: unknown, stopReason = "end_turn"): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: stopReason === "refusal" ? [] : [{ type: "text", text: JSON.stringify(output) }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function capture(reply: () => Response) {
  const requests: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return reply();
  };
  return { requests, fetchImpl };
}

describe("AnthropicSpecExtractor", () => {
  const listing = {
    title: "Heart Pendant Necklace",
    description: "Chain 40+5cm.",
    itemSpecifics: { Material: "Copper", Personalized: "Yes" },
  };
  const specs = { material: "copper", shape: "heart", sizeCm: 45, color: null, personalization: true, giftBox: null, packQuantity: 1 };

  it("requests a strict JSON schema and returns validated specs", async () => {
    const { requests, fetchImpl } = capture(() => anthropicReply(specs));
    const extractor = new AnthropicSpecExtractor(createAnthropicClient("test-key", fetchImpl));

    expect(await extractor.extractSpecs(listing)).toEqual(specs);

    const [request] = requests;
    expect(request.url).toContain("/v1/messages");
    expect(request.body.model).toBe("claude-opus-5-5");
    const outputConfig = request.body.output_config as { effort: string; format: { type: string; schema: { properties: object } } };
    expect(outputConfig.format.type).toBe("json_schema");
    expect(Object.keys(outputConfig.format.schema.properties).sort()).toEqual(Object.keys(specs).sort());
    const [message] = request.body.messages as { role: string; content: string }[];
    expect(message.content).toContain("<title>Heart Pendant Necklace</title>");
    expect(message.content).toContain("Material: Copper");
    // Thinking is always on for this model; sending a thinking config or sampling parameters would be rejected.
    expect(request.body).not.toHaveProperty("temperature");
  });

  it("treats nonsensical numbers as not stated", async () => {
    const { fetchImpl } = capture(() => anthropicReply({ ...specs, sizeCm: 0, packQuantity: 1.5 }));
    const extractor = new AnthropicSpecExtractor(createAnthropicClient("test-key", fetchImpl));
    expect(await extractor.extractSpecs(listing)).toMatchObject({ sizeCm: null, packQuantity: null });
  });

  it("fails loudly when the model declines", async () => {
    const { fetchImpl } = capture(() => anthropicReply(null, "refusal"));
    const extractor = new AnthropicSpecExtractor(createAnthropicClient("test-key", fetchImpl));
    await expect(extractor.extractSpecs(listing)).rejects.toBeInstanceOf(AnthropicOutputError);
  });
});

describe("AnthropicVisionVerifier", () => {
  const image = (name: string, contentType = "image/png") => ({
    url: `https://img/${name}`,
    bytes: new TextEncoder().encode(name),
    contentType,
  });

  it("sends at most four labelled pairs as base64 images and clamps the confidence", async () => {
    const { requests, fetchImpl } = capture(() => anthropicReply({ same: true, confidence: 1.2, differences: [] }));
    const verifier = new AnthropicVisionVerifier(createAnthropicClient("test-key", fetchImpl));
    const pairs = Array.from({ length: 5 }, (_, index) => ({ supplier: image(`s${index}`), competitor: image(`c${index}`, "image/jpeg") }));

    expect(await verifier.verifySameProduct(pairs)).toEqual({ same: true, confidence: 1, differences: [] });

    const [message] = requests[0].body.messages as { content: { type: string; text?: string; source?: { media_type: string; data: string } }[] }[];
    const images = message.content.filter((block) => block.type === "image");
    expect(images).toHaveLength(8);
    expect(images[0].source).toEqual({ type: "base64", media_type: "image/png", data: Buffer.from("s0").toString("base64") });
    expect(images[1].source?.media_type).toBe("image/jpeg");
    expect(message.content[0].text).toBe("Pair 1, supplier photo:");
    expect(message.content.at(-1)?.text).toMatch(/exact same physical product/);
  });

  it("leaves out pairs in formats Claude cannot read", async () => {
    const { requests, fetchImpl } = capture(() => anthropicReply({ same: false, confidence: 0.7, differences: ["different clasp"] }));
    const verifier = new AnthropicVisionVerifier(createAnthropicClient("test-key", fetchImpl));
    await verifier.verifySameProduct([
      { supplier: image("s0"), competitor: image("c0", "image/avif") },
      { supplier: image("s1"), competitor: image("c1") },
    ]);
    const [message] = requests[0].body.messages as { content: { type: string }[] }[];
    expect(message.content.filter((block) => block.type === "image")).toHaveLength(2);
  });

  it("answers without calling the API when there is nothing to compare", async () => {
    const { requests, fetchImpl } = capture(() => anthropicReply({}));
    const verifier = new AnthropicVisionVerifier(createAnthropicClient("test-key", fetchImpl));
    expect(await verifier.verifySameProduct([])).toMatchObject({ same: false, confidence: 0 });
    expect(requests).toHaveLength(0);
  });
});

describe("AnthropicListingCopyGenerator", () => {
  const input = {
    marketplace: "EBAY" as const,
    sourceTitle: "Custom Photo Projection Necklace",
    sourceDescription: "Heart pendant with your photo inside.",
    specs: { material: "copper", shape: "heart", sizeCm: 45, color: "rose gold", personalization: true, giftBox: false, packQuantity: null },
    keywords: ["Valentines Day Gift", "photo necklace for her"],
    maxTitleLength: 80,
  };

  it("sends the marketplace template, limit, keywords and product data, and returns the copy", async () => {
    const reply = { title: "Personalized Photo Projection Necklace, Rose Gold Heart Pendant", description: " A necklace.\n- Material: copper " };
    const { requests, fetchImpl } = capture(() => anthropicReply(reply));
    const generator = new AnthropicListingCopyGenerator(createAnthropicClient("test-key", fetchImpl));

    expect(await generator.generateListingCopy(input)).toEqual({ title: reply.title, description: "A necklace.\n- Material: copper" });

    const [request] = requests;
    expect(String(request.body.system)).toMatch(/Never use brand names, trademarks/);
    const [message] = request.body.messages as { content: string }[];
    expect(message.content).toContain("eBay listing.");
    expect(message.content).toContain("Title limit: 80 characters.");
    expect(message.content).toContain("Valentines Day Gift; photo necklace for her");
    expect(message.content).toContain("<title>Custom Photo Projection Necklace</title>");
    expect(message.content).toContain("material: copper");
    // Specs the product does not state are not sent, so the model cannot be tempted to fill them in.
    expect(message.content).not.toContain("packQuantity");
  });

  it("cuts an over-long title at a whole word", async () => {
    const long = "Personalized Photo Projection Necklace Rose Gold Heart Pendant Custom Picture Jewelry For Women And Girls";
    const { fetchImpl } = capture(() => anthropicReply({ title: long, description: "A necklace." }));
    const { title } = await new AnthropicListingCopyGenerator(createAnthropicClient("test-key", fetchImpl)).generateListingCopy(input);
    expect(title).toBe("Personalized Photo Projection Necklace Rose Gold Heart Pendant Custom Picture");
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("fails on empty copy", async () => {
    const { fetchImpl } = capture(() => anthropicReply({ title: " ", description: "x" }));
    await expect(new AnthropicListingCopyGenerator(createAnthropicClient("test-key", fetchImpl)).generateListingCopy(input)).rejects.toThrow(/empty/);
  });
});

describe("JinaClipEmbeddings", () => {
  const images = (count: number) => Array.from({ length: count }, (_, index) => ({ bytes: new Uint8Array([index]), contentType: "image/png" }));

  function jinaFetch(statuses: number[] = []) {
    const requests: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: { image: string }[] };
      requests.push({ url: String(input), headers: new Headers(init?.headers), body });
      const status = statuses.shift() ?? 200;
      if (status !== 200) return new Response("slow down", { status });
      // Reply out of order to prove the provider restores input order.
      const data = body.input.map((item, index) => ({ index, embedding: [Buffer.from(item.image, "base64")[0], 0] })).reverse();
      return new Response(JSON.stringify({ model: "jina-clip-v2", data, usage: {} }), { status: 200 });
    };
    return { requests, fetchImpl };
  }

  it("embeds in batches of 16 and keeps the input order", async () => {
    const { requests, fetchImpl } = jinaFetch();
    const vectors = await new JinaClipEmbeddings({ apiKey: "jina-key", fetch: fetchImpl }).embedImages(images(20));
    expect(vectors.map((vector) => vector[0])).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe("https://api.jina.ai/v1/embeddings");
    expect(requests[0].headers.get("authorization")).toBe("Bearer jina-key");
    expect(requests[0].body).toMatchObject({ model: "jina-clip-v2", normalized: true, embedding_type: "float" });
    expect((requests[0].body.input as unknown[]).length).toBe(16);
    expect((requests[1].body.input as unknown[]).length).toBe(4);
  });

  it("waits a full minute on a rate limit, retries server errors, and gives up on client errors", async () => {
    const retried = jinaFetch([429, 429, 503]);
    const sleeps: number[] = [];
    const provider = new JinaClipEmbeddings({ apiKey: "k", fetch: retried.fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    expect(await provider.embedImages(images(1))).toHaveLength(1);
    expect(retried.requests).toHaveLength(4);
    // The limit is per minute: each 429 waits out the window; the 503 gets a short backoff.
    expect(sleeps.slice(0, 2)).toEqual([61_000, 61_000]);
    expect(sleeps[2]).toBeLessThanOrEqual(1000);

    const stuck = jinaFetch(Array.from({ length: 11 }, () => 429));
    await expect(new JinaClipEmbeddings({ apiKey: "k", fetch: stuck.fetchImpl, sleep: async () => undefined }).embedImages(images(1))).rejects.toThrow(/429/);
    expect(stuck.requests).toHaveLength(11);

    const rejected = jinaFetch([401]);
    await expect(new JinaClipEmbeddings({ apiKey: "bad", fetch: rejected.fetchImpl }).embedImages(images(1))).rejects.toThrow(/401/);
    expect(rejected.requests).toHaveLength(1);
  });

  it("makes no request for an empty list", async () => {
    const { requests, fetchImpl } = jinaFetch();
    expect(await new JinaClipEmbeddings({ apiKey: "k", fetch: fetchImpl }).embedImages([])).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});
