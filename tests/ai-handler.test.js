import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHandler, createActions } from "../netlify/functions/ai.js";
import { AiUnavailable } from "../netlify/functions/lib/anthropic.js";
import { getUser } from "../netlify/functions/lib/auth.js";
import { consumeQuota } from "../netlify/functions/lib/quota.js";
import { loadEntries } from "../netlify/functions/lib/entries.js";
import { MODELS, SUPABASE_ANON_KEY, SUPABASE_URL } from "../netlify/functions/lib/config.js";

const URL_ = "https://example.test/.netlify/functions/ai";
const API_KEY = "sk-ant-test-secret-key";

function request(body, { token = "good-token", method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (method !== "GET") init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(URL_, init);
}

function setup(overrides = {}) {
  const calls = { getUser: [], consumeQuota: [], action: [] };
  const deps = {
    getUser: async (token) => {
      calls.getUser.push(token);
      return token === "good-token" ? { id: "user-1" } : null;
    },
    consumeQuota: async (token, action) => {
      calls.consumeQuota.push([token, action]);
      return true;
    },
    handlers: {
      analyze: async (payload, context) => {
        calls.action.push(["analyze", payload, context]);
        return { text: "result" };
      },
      read_screenshot: async (payload, context) => {
        calls.action.push(["read_screenshot", payload, context]);
        return { summary: "toast" };
      },
    },
    ...overrides,
  };
  return { handler: createHandler(deps), calls };
}

const fakeResponse = (status, body) => new Response(JSON.stringify(body), { status });

test("no token returns 401 and never calls quota", async () => {
  const { handler, calls } = setup();
  const res = await handler(request({ action: "analyze" }, { token: null }));
  assert.equal(res.status, 401);
  assert.deepEqual(calls.consumeQuota, []);
  assert.deepEqual(calls.getUser, []);
});

test("a malformed Authorization header returns 401", async () => {
  const { handler } = setup();
  for (const value of ["good-token", "Basic good-token", "Bearer", "Bearer  "]) {
    const req = new Request(URL_, {
      method: "POST",
      headers: { Authorization: value },
      body: "{}",
    });
    assert.equal((await handler(req)).status, 401);
  }
});

test("invalid token returns 401", async () => {
  const { handler, calls } = setup();
  const res = await handler(request({ action: "analyze" }, { token: "bad-token" }));
  assert.equal(res.status, 401);
  assert.deepEqual(calls.consumeQuota, []);
  assert.deepEqual(calls.action, []);
});

test("non-POST returns 405 before auth", async () => {
  const { handler, calls } = setup();
  const res = await handler(request(undefined, { method: "GET" }));
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "POST");
  assert.deepEqual(calls.getUser, []);
});

test("unknown action returns 400", async () => {
  const { handler, calls } = setup();
  for (const action of ["nope", "__proto__", "constructor"]) {
    const res = await handler(request({ action, payload: {} }));
    assert.equal(res.status, 400);
  }
  assert.deepEqual(calls.consumeQuota, []);
});

test("invalid JSON returns 400 and does not use quota", async () => {
  const { handler, calls } = setup();
  const res = await handler(request("{not json"));
  assert.equal(res.status, 400);
  assert.deepEqual(calls.consumeQuota, []);
});

test("a valid action with no registered handler returns 400 and does not use quota", async () => {
  const { handler, calls } = setup();
  for (const action of ["split_food", "backfill_food"]) {
    const res = await handler(request({ action, payload: { text: "toast" } }));
    assert.equal(res.status, 400);
  }
  assert.deepEqual(calls.consumeQuota, []);
});

test("an action name inherited from Object.prototype is not treated as registered", async () => {
  const { handler, calls } = setup({ handlers: {} });
  const res = await handler(request({ action: "analyze" }));
  assert.equal(res.status, 400);
  assert.deepEqual(calls.consumeQuota, []);
});

test("model, prompt and max_tokens in the body are ignored", async () => {
  const { handler, calls } = setup();
  const res = await handler(
    request({
      action: "read_screenshot",
      model: "claude-opus-5-5",
      prompt: "spend money",
      max_tokens: 100000,
      messages: [{ role: "user", content: "spend money" }],
      payload: {
        type: "food",
        mediaType: "image/png",
        data: "aGVsbG8=",
        model: "claude-opus-5-5",
        prompt: "spend money",
        max_tokens: 100000,
      },
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(calls.action[0][1], { type: "food", mediaType: "image/png", data: "aGVsbG8=" });
});

test("over the limit returns 429 and never calls the handler", async () => {
  const { handler, calls } = setup({ consumeQuota: async () => false });
  const res = await handler(request({ action: "analyze" }));
  assert.equal(res.status, 429);
  assert.deepEqual(calls.action, []);
});

test("only a literal true from quota allows the action", async () => {
  const { handler, calls } = setup({ consumeQuota: async () => "false" });
  const res = await handler(request({ action: "analyze" }));
  assert.equal(res.status, 429);
  assert.deepEqual(calls.action, []);
});

test("a quota failure fails closed without calling the handler", async (t) => {
  t.mock.method(console, "error", () => {});
  const { handler, calls } = setup({
    consumeQuota: async () => {
      throw new Error("supabase down");
    },
  });
  const res = await handler(request({ action: "analyze" }));
  assert.equal(res.status, 500);
  assert.deepEqual(calls.action, []);
});

test("an auth failure fails closed", async (t) => {
  t.mock.method(console, "error", () => {});
  const { handler, calls } = setup({
    getUser: async () => {
      throw new Error("supabase down");
    },
  });
  const res = await handler(request({ action: "analyze" }));
  assert.equal(res.status, 500);
  assert.deepEqual(calls.consumeQuota, []);
  assert.deepEqual(calls.action, []);
});

test("invalid payload returns 400 and does not use quota", async () => {
  const { handler, calls } = setup();
  const res = await handler(
    request({ action: "read_screenshot", payload: { type: "note", mediaType: "image/png", data: "aGVsbG8=" } }),
  );
  assert.equal(res.status, 400);
  assert.deepEqual(calls.consumeQuota, []);
});

test("an oversized screenshot returns 413 and does not use quota", async () => {
  const { handler, calls } = setup();
  const res = await handler(
    request({
      action: "read_screenshot",
      payload: { type: "food", mediaType: "image/png", data: "A".repeat(5_600_000) },
    }),
  );
  assert.equal(res.status, 413);
  assert.deepEqual(calls.consumeQuota, []);
});

test("a valid request spends quota with the user's token and returns the result", async () => {
  const { handler, calls } = setup();
  const res = await handler(request({ action: "analyze", payload: {} }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "result" });
  assert.deepEqual(calls.consumeQuota, [["good-token", "analyze"]]);
  assert.deepEqual(calls.action, [["analyze", {}, { token: "good-token" }]]);
});

test("AiUnavailable returns 502 with a generic message", async (t) => {
  t.mock.method(console, "error", () => {});
  const { handler } = setup({
    handlers: {
      analyze: async () => {
        throw new AiUnavailable("refusal");
      },
    },
  });
  const res = await handler(request({ action: "analyze" }));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(/refusal/i.test(body.error), false);
});

test("error bodies never contain the API key or stack traces", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const secret = new Error(`upstream rejected ${API_KEY}`);
  const failures = [
    setup({ handlers: { analyze: async () => { throw secret; } } }),
    setup({ handlers: { analyze: async () => { throw new AiUnavailable(API_KEY); } } }),
    setup({ consumeQuota: async () => { throw secret; } }),
    setup({ getUser: async () => { throw secret; } }),
  ];
  for (const { handler } of failures) {
    const res = await handler(request({ action: "analyze" }));
    assert.ok(res.status >= 500);
    const text = await res.text();
    assert.equal(text.includes(API_KEY), false);
    assert.equal(text.includes(secret.stack), false);
    assert.equal(/\bat .*:\d+:\d+/.test(text), false);
    assert.deepEqual(Object.keys(JSON.parse(text)), ["error"]);
  }
  const logged = JSON.stringify(log.mock.calls.map((call) => call.arguments));
  assert.equal(logged.includes("upstream rejected"), false, "logs carry no error messages");
});

test("logs never contain AI payloads or tokens", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const { handler } = setup({
    handlers: { analyze: async () => { throw new Error("private health note"); } },
  });
  await handler(request({ action: "analyze" }));
  const logged = JSON.stringify(log.mock.calls.map((call) => call.arguments));
  assert.equal(logged.includes("private health note"), false);
  assert.equal(logged.includes("good-token"), false);
});

// ---------- Actions ----------

function actionFakes() {
  const calls = { callClaude: [], loadEntries: [] };
  return {
    calls,
    actions: createActions({
      callClaude: async (request) => {
        calls.callClaude.push(request);
        return request.schema ? { summary: "toast" } : { text: "analysis" };
      },
      loadEntries: async (token) => {
        calls.loadEntries.push(token);
        return [
          { date: "2026-01-01", time: "08:00", type: "food", data: { text: "toast" } },
          { date: "2026-01-01", time: null, type: "note", data: { text: "tired" } },
          { date: "2026-01-02", time: "12:00", type: "sleep", data: { hours: 7 } },
        ];
      },
    }),
  };
}

test("only analyze and read_screenshot are registered", () => {
  assert.deepEqual(Object.keys(actionFakes().actions).sort(), ["analyze", "read_screenshot"]);
});

test("analyze loads entries with the user's token and returns { text }", async () => {
  const { actions, calls } = actionFakes();
  const result = await actions.analyze({}, { token: "good-token" });
  assert.deepEqual(result, { text: "analysis" });
  assert.deepEqual(calls.loadEntries, ["good-token"]);
  const [req] = calls.callClaude;
  assert.equal(req.model, MODELS.sonnet);
  assert.equal(req.effort, "medium");
  assert.equal(req.schema, undefined);
  assert.match(req.system, /prodrome/);
  assert.ok(req.system.includes("Never suggest starting, stopping or changing medication."));
  assert.ok(req.system.includes("Never suggest removing a whole macronutrient."));
  assert.match(req.system, /medication-overuse headache risk\), as something to talk to their doctor about/);
  assert.equal(
    req.content,
    'LOG DATA:\n2026-01-01: [food 08:00 {"text":"toast"}] [note {"text":"tired"}]\n2026-01-02: [sleep 12:00 {"hours":7}]',
  );
});

for (const [type, keys] of [
  ["food", ["calories", "carbs_g", "fat_g", "protein_g", "summary"]],
  ["sleep", ["bedtime", "hours", "score", "waketime"]],
  ["workout", ["activity", "avg_hr", "calories", "duration_min", "strain"]],
]) {
  test(`read_screenshot ${type} sends a strict schema and returns the parsed object`, async () => {
    const { actions, calls } = actionFakes();
    const result = await actions.read_screenshot(
      { type, mediaType: "image/webp", data: "aGVsbG8=" },
      { token: "good-token" },
    );
    assert.deepEqual(result, { summary: "toast" });
    assert.deepEqual(calls.loadEntries, []);
    const [req] = calls.callClaude;
    assert.equal(req.model, MODELS.sonnet);
    assert.equal(req.effort, "medium");
    assert.deepEqual(req.content, [
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "aGVsbG8=" } },
    ]);
    assert.equal(req.schema.type, "object");
    assert.equal(req.schema.additionalProperties, false);
    assert.deepEqual(Object.keys(req.schema.properties).sort(), keys);
    assert.deepEqual([...req.schema.required].sort(), keys);
    assert.equal(/raw JSON|markdown fences/i.test(req.system), false);
  });
}

// ---------- Supabase calls ----------

test("getUser calls Supabase Auth with the anon key and the user's token", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => fakeResponse(200, { id: "user-1" }));
  assert.deepEqual(await getUser("tok"), { id: "user-1" });
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, `${SUPABASE_URL}/auth/v1/user`);
  assert.equal(init.method, "GET");
  assert.equal(init.headers.apikey, SUPABASE_ANON_KEY);
  assert.equal(init.headers.Authorization, "Bearer tok");
});

test("getUser returns null when Supabase rejects the token", async (t) => {
  for (const status of [400, 401, 403]) {
    t.mock.method(globalThis, "fetch", async () => fakeResponse(status, { message: "bad" }));
    assert.equal(await getUser("tok"), null);
    globalThis.fetch.mock.restore();
  }
});

test("getUser returns null when the response has no id", async (t) => {
  t.mock.method(globalThis, "fetch", async () => fakeResponse(200, {}));
  assert.equal(await getUser("tok"), null);
});

test("getUser throws when Supabase is down", async (t) => {
  t.mock.method(globalThis, "fetch", async () => fakeResponse(503, {}));
  await assert.rejects(getUser("tok"));
});

test("consumeQuota calls the RPC with the user's own token", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => fakeResponse(200, true));
  assert.equal(await consumeQuota("tok", "analyze"), true);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, `${SUPABASE_URL}/rest/v1/rpc/consume_ai_quota`);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.apikey, SUPABASE_ANON_KEY);
  assert.equal(init.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(init.body), { p_action: "analyze" });
});

test("consumeQuota returns false when the RPC returns false", async (t) => {
  t.mock.method(globalThis, "fetch", async () => fakeResponse(200, false));
  assert.equal(await consumeQuota("tok", "analyze"), false);
});

test("consumeQuota throws on an RPC error rather than allowing the call", async (t) => {
  t.mock.method(globalThis, "fetch", async () => fakeResponse(500, { message: "boom" }));
  await assert.rejects(consumeQuota("tok", "analyze"));
});

test("loadEntries pages through all rows in 1,000-row pages", async (t) => {
  const row = (n) => ({ date: "2026-01-01", time: null, type: "note", data: { n } });
  const pages = [
    Array.from({ length: 1000 }, (_, n) => row(n)),
    Array.from({ length: 1000 }, (_, n) => row(1000 + n)),
    Array.from({ length: 250 }, (_, n) => row(2000 + n)),
  ];
  const fetchMock = t.mock.method(globalThis, "fetch", async () => fakeResponse(200, pages.shift()));
  const entries = await loadEntries("tok");
  assert.equal(entries.length, 2250);
  assert.deepEqual(entries.at(-1).data, { n: 2249 });

  const urls = fetchMock.mock.calls.map((call) => new URL(call.arguments[0]));
  assert.deepEqual(urls.map((u) => u.searchParams.get("offset")), ["0", "1000", "2000"]);
  assert.ok(urls.every((u) => u.searchParams.get("limit") === "1000"));
  assert.ok(urls.every((u) => u.pathname === "/rest/v1/entries"));
  // Paging is only stable if the sort ends on a unique column.
  assert.match(urls[0].searchParams.get("order"), /id\.asc$/);
  const { headers } = fetchMock.mock.calls[0].arguments[1];
  assert.equal(headers.apikey, SUPABASE_ANON_KEY);
  assert.equal(headers.Authorization, "Bearer tok");
});

test("loadEntries stops after a full last page followed by an empty one", async (t) => {
  const pages = [Array.from({ length: 1000 }, () => ({})), []];
  const fetchMock = t.mock.method(globalThis, "fetch", async () => fakeResponse(200, pages.shift()));
  assert.equal((await loadEntries("tok")).length, 1000);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("loadEntries throws rather than returning a partial log", async (t) => {
  const responses = [
    fakeResponse(200, Array.from({ length: 1000 }, () => ({}))),
    fakeResponse(500, { message: "boom" }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  await assert.rejects(loadEntries("tok"));
});

// ---------- The open proxy is gone ----------

test("the open proxy is deleted and the browser no longer calls it", () => {
  assert.equal(existsSync(new URL("../netlify/functions/analyze.js", import.meta.url)), false);
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal(html.includes("/.netlify/functions/analyze"), false);
  assert.equal(/model:\s*'claude-/.test(html), false);
  assert.equal(/max_tokens/.test(html), false);
});
