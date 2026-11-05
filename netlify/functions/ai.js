import { bearerToken, getUser } from "./lib/auth.js";
import { AiUnavailable, callClaude } from "./lib/anthropic.js";
import { MODELS } from "./lib/config.js";
import { FOOD_SCHEMA, validateItems } from "./lib/food.js";
import { loadEntries } from "./lib/entries.js";
import { ANALYZE_SYSTEM, SCREENSHOTS, SPLIT_FOOD_SYSTEM, formatLog } from "./lib/prompts.js";
import { consumeQuota } from "./lib/quota.js";
import { ValidationError, validateRequest } from "./lib/validate.js";

const json = (status, body, headers) => Response.json(body, { status, headers });

export function createHandler({ getUser, consumeQuota, handlers }) {
  return async (req) => {
    if (req.method !== "POST") {
      return json(405, { error: "Method not allowed." }, { Allow: "POST" });
    }

    let action;
    try {
      const token = bearerToken(req);
      if (!token || !(await getUser(token))) {
        return json(401, { error: "Please sign in." });
      }

      const body = await req.json().catch(() => {
        throw new ValidationError("Invalid request.");
      });
      const validated = validateRequest(body);
      action = validated.action;
      if (!Object.hasOwn(handlers, action)) {
        throw new ValidationError("Unknown action.");
      }

      if ((await consumeQuota(token, action)) !== true) {
        return json(429, { error: "You've reached today's limit for this. Try again tomorrow." });
      }

      return json(200, await handlers[action](validated.payload, { token }));
    } catch (err) {
      if (err instanceof ValidationError) {
        return json(err.status, { error: err.message });
      }
      // Labels only. Error messages can hold health data, so they are not logged.
      console.error("ai function failed", {
        action,
        error: err?.name,
        reason: err instanceof AiUnavailable ? err.reason : undefined,
        status: err?.status,
      });
      if (err instanceof AiUnavailable) {
        return json(502, { error: "The AI service is unavailable. Try again later." });
      }
      return json(500, { error: "Something went wrong. Try again later." });
    }
  };
}

export function createActions({ callClaude, loadEntries }) {
  // 8000 tokens: a 2,000-character entry can hold dozens of foods at about
  // 70 tokens each, and thinking counts toward max_tokens too.
  const splitFood = async ({ text }) => {
    const result = await callClaude({
      model: MODELS.haiku,
      effort: "low",
      maxTokens: 8000,
      system: SPLIT_FOOD_SYSTEM,
      content: text,
      schema: FOOD_SCHEMA,
    });
    return { items: validateItems(result?.items) };
  };

  return {
    analyze: async (_payload, { token }) =>
      callClaude({
        model: MODELS.sonnet,
        effort: "medium",
        maxTokens: 4000,
        system: ANALYZE_SYSTEM,
        content: formatLog(await loadEntries(token)),
      }),

    read_screenshot: async ({ type, mediaType, data }) =>
      callClaude({
        model: MODELS.sonnet,
        effort: "medium",
        maxTokens: 2000,
        system: SCREENSHOTS[type].system,
        content: [{ type: "image", source: { type: "base64", media_type: mediaType, data } }],
        schema: SCREENSHOTS[type].schema,
      }),

    // Old entries use the same call, with their own daily quota.
    split_food: splitFood,
    backfill_food: splitFood,
  };
}

const handle = createHandler({
  getUser,
  consumeQuota,
  handlers: createActions({ callClaude, loadEntries }),
});

export default async (req) => handle(req);
