import Anthropic from "@anthropic-ai/sdk";
import { AI_TIMEOUT_MS, MODELS } from "./config.js";

const SONNET_FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

// `reason` is a short label for logs. Nothing from the prompt, the response or
// the upstream error message goes in this error.
export class AiUnavailable extends Error {
  constructor(reason, status) {
    super("AI service unavailable");
    this.name = "AiUnavailable";
    this.reason = reason;
    this.status = status;
  }
}

export function createClient(apiKey = process.env.ANTHROPIC_API_KEY) {
  return new Anthropic({ apiKey, timeout: AI_TIMEOUT_MS, maxRetries: 1 });
}

let defaultClient;
function getDefaultClient() {
  defaultClient ??= createClient();
  return defaultClient;
}

async function send(params, client) {
  // The SDK timeout applies per attempt. This deadline covers the retry too, so
  // the function always answers before Netlify's 60-second limit.
  const options = { signal: AbortSignal.timeout(AI_TIMEOUT_MS) };
  try {
    if (params.model === MODELS.sonnet) {
      return await client.beta.messages.create({ ...params, ...SONNET_FALLBACK }, options);
    }
    return await client.messages.create(params, options);
  } catch (err) {
    throw new AiUnavailable("request_failed", err?.status);
  }
}

// Returns the parsed object when `schema` is given, otherwise `{ text }`.
export async function callClaude(
  { model, effort, maxTokens, system, content, schema },
  client = getDefaultClient(),
) {
  const response = await send(
    {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
      output_config: {
        effort,
        ...(schema && { format: { type: "json_schema", schema } }),
      },
    },
    client,
  );

  if (response.stop_reason !== "end_turn") {
    throw new AiUnavailable(`stop_${response.stop_reason}`);
  }

  // Thinking and fallback blocks can come before the answer.
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (text === "") throw new AiUnavailable("empty_response");
  if (!schema) return { text };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiUnavailable("unparseable_response");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AiUnavailable("unparseable_response");
  }
  return parsed;
}
