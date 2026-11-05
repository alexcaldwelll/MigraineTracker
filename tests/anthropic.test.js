import { test } from "node:test";
import assert from "node:assert/strict";
import { callClaude, createClient, AiUnavailable } from "../netlify/functions/lib/anthropic.js";
import { MODELS } from "../netlify/functions/lib/config.js";

const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

function fakeClient(response) {
  const calls = { stable: [], beta: [] };
  const create = (list) => async (params, options) => {
    list.push({ params, options });
    if (response instanceof Error) throw response;
    return response;
  };
  return {
    calls,
    messages: { create: create(calls.stable) },
    beta: { messages: { create: create(calls.beta) } },
  };
}

const done = (text) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
});

const request = (overrides = {}) => ({
  model: MODELS.sonnet,
  effort: "medium",
  maxTokens: 500,
  system: "system prompt",
  content: "user content",
  schema,
  ...overrides,
});

test("model IDs are the exact current IDs", () => {
  assert.equal(MODELS.sonnet, "claude-sonnet-5-5");
  assert.equal(MODELS.haiku, "claude-haiku-5-5");
});

test("createClient sets a 50-second timeout and one retry", () => {
  const client = createClient("test-key");
  assert.equal(client.timeout, 50_000);
  assert.equal(client.maxRetries, 1);
});

test("the request has output_config.format with type json_schema", async () => {
  const client = fakeClient(done('{"ok":true}'));
  await callClaude(request(), client);
  const { params } = client.calls.beta[0];
  assert.deepEqual(params.output_config, {
    effort: "medium",
    format: { type: "json_schema", schema },
  });
});

test("the request maps fields and sets no banned parameters", async () => {
  for (const model of [MODELS.sonnet, MODELS.haiku]) {
    const client = fakeClient(done('{"ok":true}'));
    await callClaude(request({ model, content: [{ type: "text", text: "hi" }] }), client);
    const { params } = client.calls.beta[0] ?? client.calls.stable[0];
    assert.equal(params.model, model);
    assert.equal(params.max_tokens, 500);
    assert.equal(params.system, "system prompt");
    assert.deepEqual(params.messages, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    for (const banned of ["tool_choice", "tools", "temperature", "top_p", "top_k", "thinking"]) {
      assert.equal(banned in params, false, `${banned} must not be sent`);
    }
  }
});

test("Sonnet uses the beta client with the fallback beta", async () => {
  const client = fakeClient(done('{"ok":true}'));
  await callClaude(request({ model: MODELS.sonnet }), client);
  assert.equal(client.calls.stable.length, 0);
  assert.equal(client.calls.beta.length, 1);
  const { params } = client.calls.beta[0];
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.fallbacks, "default");
});

test("Haiku uses the stable client and omits betas and fallbacks", async () => {
  const client = fakeClient(done('{"ok":true}'));
  await callClaude(request({ model: MODELS.haiku, effort: "low" }), client);
  assert.equal(client.calls.beta.length, 0);
  assert.equal(client.calls.stable.length, 1);
  const { params } = client.calls.stable[0];
  assert.equal("betas" in params, false);
  assert.equal("fallbacks" in params, false);
  assert.equal(params.output_config.effort, "low");
});

test("every attempt shares one 50-second deadline, retries included", async () => {
  const client = fakeClient(done('{"ok":true}'));
  await callClaude(request(), client);
  assert.ok(client.calls.beta[0].options.signal instanceof AbortSignal);
  assert.equal(client.calls.beta[0].options.signal.aborted, false);
});

test("returns the parsed object", async () => {
  const client = fakeClient(done('{"ok":true}'));
  assert.deepEqual(await callClaude(request(), client), { ok: true });
});

test("reads the text block when thinking and fallback blocks come first", async () => {
  const client = fakeClient({
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "" },
      { type: "fallback", from: { model: "a" }, to: { model: "b" } },
      { type: "text", text: '{"ok":true}' },
    ],
  });
  assert.deepEqual(await callClaude(request(), client), { ok: true });
});

test("without a schema it omits format and returns { text }", async () => {
  const client = fakeClient(done("plain words"));
  assert.deepEqual(await callClaude(request({ schema: undefined }), client), { text: "plain words" });
  assert.deepEqual(client.calls.beta[0].params.output_config, { effort: "medium" });
});

for (const stop_reason of ["refusal", "max_tokens", "pause_turn", "tool_use", "model_context_window_exceeded"]) {
  test(`stop_reason ${stop_reason} throws AiUnavailable even with usable content`, async () => {
    const client = fakeClient({ stop_reason, content: [{ type: "text", text: '{"ok":true}' }] });
    await assert.rejects(callClaude(request(), client), AiUnavailable);
  });
}

for (const text of ["not json", "", "null", "5", '"text"', "[]"]) {
  test(`schema output ${JSON.stringify(text)} throws AiUnavailable`, async () => {
    await assert.rejects(callClaude(request(), fakeClient(done(text))), AiUnavailable);
  });
}

test("a response with no text block throws AiUnavailable", async () => {
  const client = fakeClient({ stop_reason: "end_turn", content: [] });
  await assert.rejects(callClaude(request(), client), AiUnavailable);
  await assert.rejects(callClaude(request({ schema: undefined }), client), AiUnavailable);
});

test("SDK errors become AiUnavailable and do not carry the original message", async () => {
  const client = fakeClient(Object.assign(new Error("sk-ant-secret leaked"), { status: 529 }));
  await assert.rejects(callClaude(request(), client), (err) => {
    assert.ok(err instanceof AiUnavailable);
    assert.equal(err.message.includes("sk-ant-secret"), false);
    assert.equal(err.status, 529);
    return true;
  });
});
