import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHandler, createActions } from "../netlify/functions/ai.js";
import { AiUnavailable } from "../netlify/functions/lib/anthropic.js";
import { getUser } from "../netlify/functions/lib/auth.js";
import { consumeQuota } from "../netlify/functions/lib/quota.js";
import { groupByDate, loadEntries, loadMeds } from "../netlify/functions/lib/entries.js";
import { INSIGHT_SCHEMA } from "../netlify/functions/lib/insight.js";
import { ANALYZE_SYSTEM } from "../netlify/functions/lib/prompts.js";
import { buildStats } from "../public/js/patterns.js";
import { MODELS, SUPABASE_ANON_KEY, SUPABASE_URL } from "../netlify/functions/lib/config.js";

const URL_ = "https://example.test/.netlify/functions/ai";
const API_KEY = "sk-ant-test-secret-key";
const ANALYZE = { action: "analyze", payload: { today: "2026-01-03" } };

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
  const res = await handler(request(ANALYZE, { token: null }));
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
  const res = await handler(request(ANALYZE, { token: "bad-token" }));
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
  const res = await handler(request({ action: "backfill_food", payload: { text: "toast" } }));
  assert.equal(res.status, 400);
  assert.deepEqual(calls.consumeQuota, []);
});

test("an action name inherited from Object.prototype is not treated as registered", async () => {
  const { handler, calls } = setup({ handlers: {} });
  const res = await handler(request(ANALYZE));
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
  const res = await handler(request(ANALYZE));
  assert.equal(res.status, 429);
  assert.deepEqual(calls.action, []);
});

test("only a literal true from quota allows the action", async () => {
  const { handler, calls } = setup({ consumeQuota: async () => "false" });
  const res = await handler(request(ANALYZE));
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
  const res = await handler(request(ANALYZE));
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
  const res = await handler(request(ANALYZE));
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
  const res = await handler(request(ANALYZE));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "result" });
  assert.deepEqual(calls.consumeQuota, [["good-token", "analyze"]]);
  assert.deepEqual(calls.action, [["analyze", { today: "2026-01-03" }, { token: "good-token" }]]);
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
  const res = await handler(request(ANALYZE));
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
    const res = await handler(request(ANALYZE));
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
  await handler(request(ANALYZE));
  const logged = JSON.stringify(log.mock.calls.map((call) => call.arguments));
  assert.equal(logged.includes("private health note"), false);
  assert.equal(logged.includes("good-token"), false);
});

// ---------- Actions ----------

const GOOD_ANSWER = {
  try_next: {
    title: "Skip cheddar for 2 weeks",
    action: "Do this for the next 2 weeks",
    why: "Cheddar came before 2 of 2 headaches.",
    confidence: "strong",
    days: 14,
    factor_key: null,
  },
  also_watching: [],
  keep_logging: "Keep logging sleep.",
  doctor_questions: [],
  cycle_note: null,
};

function actionFakes({ answer = GOOD_ANSWER, callClaude, rows, meds = [], trials = [] } = {}) {
  const calls = { callClaude: [], loadEntries: [], loadMeds: [], loadTrials: [] };
  return {
    calls,
    actions: createActions({
      callClaude: async (request) => {
        calls.callClaude.push(request);
        if (callClaude) return callClaude(request);
        return request.system === ANALYZE_SYSTEM ? answer : { summary: "toast" };
      },
      loadEntries: async (token) => {
        calls.loadEntries.push(token);
        return rows ?? [
          { date: "2026-01-01", time: "08:00", type: "food", data: { text: "toast" } },
          { date: "2026-01-01", time: null, type: "note", data: { text: "tired" } },
          { date: "2026-01-02", time: "12:00", type: "sleep", data: { hours: 7 } },
        ];
      },
      loadMeds: async (token) => {
        calls.loadMeds.push(token);
        return meds;
      },
      loadTrials: async (token) => {
        calls.loadTrials.push(token);
        return trials;
      },
    }),
  };
}

const TODAY = { today: "2026-01-03" };
const CONTEXT = { token: "good-token" };

// Cheddar the day before every headache, rice on the days between.
function patternRows() {
  const rows = [];
  for (let n = 0; n < 60; n++) {
    const date = new Date(Date.UTC(2025, 10, 1 + n)).toISOString().slice(0, 10);
    const name = n % 10 === 4 ? "cheddar" : "rice";
    rows.push({ date, time: "12:00", type: "food", data: { text: name, split_status: "done", items: [{ name, food_type: "other", tags: [] }] } });
    if (n % 10 === 5) rows.push({ date, time: "15:00", type: "headache", data: { severity: 5 } });
  }
  return rows;
}

test("analyze, backfill_food, read_screenshot and split_food are registered", () => {
  assert.deepEqual(Object.keys(actionFakes().actions).sort(), ["analyze", "backfill_food", "read_screenshot", "split_food"]);
});

test("analyze loads everything with the user's token and asks Sonnet for the schema", async () => {
  const { actions, calls } = actionFakes({ trials: [{ status: "completed", suggestion: { title: "Old trial" } }] });
  const out = await actions.analyze(TODAY, CONTEXT);
  assert.equal(out.source, "ai");
  assert.equal(out.result.try_next.title, GOOD_ANSWER.try_next.title);
  assert.deepEqual(calls.loadEntries, ["good-token"]);
  assert.deepEqual(calls.loadMeds, ["good-token"]);
  assert.deepEqual(calls.loadTrials, ["good-token"]);
  const [req] = calls.callClaude;
  assert.equal(req.model, MODELS.sonnet);
  assert.equal(req.effort, "medium");
  assert.equal(req.maxTokens, 8000);
  assert.equal(req.schema, INSIGHT_SCHEMA);
  assert.match(req.content, /STATS:/);
  assert.match(req.content, /Old trial/);
  assert.match(req.content, /2026-01-01: \[food 08:00 \["toast"\]\] \[note \{"text":"tired"\}\]\n2026-01-02: \[sleep 12:00 \{"hours":7\}\]/);
});

test("the analyze prompt carries every rule", () => {
  for (const rule of [
    "Never suggest starting, stopping or changing medication.",
    "Never suggest removing a whole macronutrient.",
  ]) assert.ok(ANALYZE_SYSTEM.includes(rule), rule);
  for (const pattern of [
    /prodrome/,
    /medication-overuse headache risk\), as something to talk to their doctor about/,
    /Only one change/,
    /2 to 4 weeks/,
    /doctor question/,
    /caffeine[^.]*gradually/i,
    /data[^.]*never[^.]*instructions/i,
    /plain[^.]*language/i,
    /past trial/i,
    /no pattern/i,
    /what to log next/i,
    /early guess/,
  ]) assert.match(ANALYZE_SYSTEM, pattern);
});

test("the stats reach Claude trimmed, and the engine sets the confidence", async () => {
  const { actions, calls } = actionFakes({
    rows: patternRows(),
    answer: { ...GOOD_ANSWER, try_next: { ...GOOD_ANSWER.try_next, confidence: "early guess", factor_key: "food:cheddar" } },
  });
  const out = await actions.analyze({ today: "2026-01-10" }, CONTEXT);
  assert.match(calls.callClaude[0].content, /"key":"food:cheddar"/);
  assert.doesNotMatch(calls.callClaude[0].content, /"key":"food:rice"/, "rice leans away from headaches");
  const stats = buildStats(groupByDate(patternRows()), { today: "2026-01-10" });
  const cheddar = stats.factors.find((f) => f.key === "food:cheddar");
  assert.notEqual(cheddar.confidence, "early guess", "the fixture needs a real signal");
  assert.equal(out.result.try_next.confidence, cheddar.confidence);
});

test("analyze cannot claim confidence for a factor it was not given", async () => {
  const { actions } = actionFakes({
    rows: patternRows(),
    answer: { ...GOOD_ANSWER, try_next: { ...GOOD_ANSWER.try_next, factor_key: "food:rice" } },
  });
  const out = await actions.analyze({ today: "2026-01-10" }, CONTEXT);
  assert.equal(out.source, "ai");
  assert.equal(out.result.try_next.confidence, "early guess");
});

for (const [name, setup_] of [
  ["callClaude throws AiUnavailable", { callClaude: () => { throw new AiUnavailable("request_failed", 529); } }],
  ["callClaude throws anything else", { callClaude: () => { throw new TypeError("boom"); } }],
  ["try_next is missing", { answer: { ...GOOD_ANSWER, try_next: undefined } }],
  ["try_next names a logged med", { answer: { ...GOOD_ANSWER, try_next: { ...GOOD_ANSWER.try_next, title: "Skip Zofran for 2 weeks" } } }],
  ["try_next names a med from the list", { answer: { ...GOOD_ANSWER, try_next: { ...GOOD_ANSWER.try_next, title: "Skip Topiramate for 2 weeks" } } }],
  ["try_next cuts a macro", { answer: { ...GOOD_ANSWER, try_next: { ...GOOD_ANSWER.try_next, title: "Cut carbs for 2 weeks" } } }],
  ["days is out of range", { answer: { ...GOOD_ANSWER, try_next: { ...GOOD_ANSWER.try_next, days: 60 } } }],
]) {
  test(`analyze returns the rule result when ${name}`, async (t) => {
    const log = t.mock.method(console, "error", () => {});
    const rows = [
      { date: "2026-01-01", time: "08:00", type: "meds", data: { name: "Zofran", category: "acute" } },
      { date: "2026-01-02", time: "12:00", type: "sleep", data: { hours: 7 } },
    ];
    const { actions } = actionFakes({ ...setup_, rows, meds: [{ name: "Topiramate" }] });
    const out = await actions.analyze(TODAY, CONTEXT);
    assert.equal(out.source, "rules");
    assert.ok(out.result.try_next.title);
    assert.ok(Number.isInteger(out.result.try_next.days));
    assert.equal(log.mock.callCount(), 1);
    assert.equal(JSON.stringify(log.mock.calls[0].arguments).includes("boom"), false, "labels only");
  });
}

test("a failed load is an error, so nothing is checked against a partial med list", async () => {
  const actions = createActions({
    callClaude: async () => GOOD_ANSWER,
    loadEntries: async () => [],
    loadMeds: async () => { throw new Error("Could not load meds"); },
  });
  await assert.rejects(actions.analyze(TODAY, CONTEXT), /Could not load meds/);
});

test("past trials default to none until trials load", async () => {
  let content;
  const actions = createActions({
    callClaude: async (req) => { content = req.content; return GOOD_ANSWER; },
    loadEntries: async () => [],
    loadMeds: async () => [],
  });
  assert.equal((await actions.analyze(TODAY, CONTEXT)).source, "ai");
  assert.match(content, /PAST TRIALS:\n\[\]/);
});

test("the analyze quota is spent before the rule fallback runs", async (t) => {
  t.mock.method(console, "error", () => {});
  const { actions } = actionFakes({ callClaude: () => { throw new AiUnavailable("x"); } });
  const { handler, calls } = setup({ handlers: actions });
  const res = await handler(request(ANALYZE));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).source, "rules");
  assert.deepEqual(calls.consumeQuota, [["good-token", "analyze"]]);
});

test("a bad today is refused before quota", async () => {
  const { handler, calls } = setup();
  const res = await handler(request({ action: "analyze", payload: { today: "tomorrow" } }));
  assert.equal(res.status, 400);
  assert.deepEqual(calls.consumeQuota, []);
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

test("groupByDate turns rows into days shaped like the browser's", () => {
  assert.deepEqual(
    groupByDate([
      { date: "2026-01-01", time: "08:00", type: "food", data: { text: "toast" } },
      { date: "2026-01-01", time: null, type: "note", data: { text: "tired" } },
      { date: "2026-01-02", time: "12:00", type: "sleep", data: { hours: 7 } },
    ]),
    [
      { date: "2026-01-01", entries: [{ type: "food", time: "08:00", text: "toast" }, { type: "note", time: null, text: "tired" }] },
      { date: "2026-01-02", entries: [{ type: "sleep", time: "12:00", hours: 7 }] },
    ],
  );
});

test("loadMeds asks Supabase for the user's med names with their token", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => fakeResponse(200, [{ name: "Topiramate" }]));
  assert.deepEqual(await loadMeds("tok"), [{ name: "Topiramate" }]);
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.ok(url.startsWith(`${SUPABASE_URL}/rest/v1/meds_catalog?`));
  assert.ok(url.includes("select=name"));
  assert.equal(init.headers.Authorization, "Bearer tok");
});

test("loadMeds throws rather than returning no meds", async (t) => {
  t.mock.method(globalThis, "fetch", async () => fakeResponse(500, {}));
  await assert.rejects(loadMeds("tok"));
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
  const jsDir = new URL("../public/js/", import.meta.url);
  const browserCode = [
    readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
    ...readdirSync(jsDir).map((file) => readFileSync(new URL(file, jsDir), "utf8")),
  ].join("\n");
  assert.equal(browserCode.includes("/.netlify/functions/analyze"), false);
  assert.equal(/model:\s*'claude-/.test(browserCode), false);
  assert.equal(/max_tokens/.test(browserCode), false);
});

test("split_food rejects text over 2,000 characters before quota", async () => {
  const { handler, calls } = setup({
    handlers: { split_food: async () => ({ items: [] }) },
  });
  const res = await handler(request({ action: "split_food", payload: { text: "a".repeat(2001) } }));
  assert.equal(res.status, 413);
  assert.deepEqual(calls.consumeQuota, []);
});

test("split_food uses haiku at low effort with the food schema and validates the result", async () => {
  const calls = [];
  const actions = createActions({
    callClaude: async (req) => {
      calls.push(req);
      return { items: [{ name: "tea", main_macro: "carbs", food_type: "drinks", protein_g: 0, carbs_g: 0, fat_g: 0, tags: ["caffeine", "bogus"] }] };
    },
    loadEntries: async () => [],
  });
  const result = await actions.split_food({ text: "tea" });
  assert.equal(calls[0].model, MODELS.haiku);
  assert.equal(calls[0].effort, "low");
  assert.equal(calls[0].content, "tea");
  assert.ok(calls[0].schema);
  assert.deepEqual(result.items[0].tags, ["caffeine"]);
});

test("backfill_food matches split_food and an unknown action is refused before quota", async () => {
  const calls = [];
  const actions = createActions({
    callClaude: async (req) => { calls.push(req); return { items: [] }; },
    loadEntries: async () => [],
  });
  assert.deepEqual(await actions.backfill_food({ text: "tea" }), { items: [] });
  await actions.split_food({ text: "tea" });
  assert.deepEqual(calls[0], calls[1]);
  assert.match(calls[0].system, /bracketed totals/);
  const { handler, calls: c } = setup({ handlers: {} });
  assert.equal((await handler(request({ action: "made_up", payload: {} }))).status, 400);
  assert.deepEqual(c.consumeQuota, []);
});

const acuteDays = (count) => Array.from({ length: count }, (_, i) => ({
  date: `2026-01-${String(i + 1).padStart(2, "0")}`, time: "08:00", type: "meds", data: { name: "Advil", category: "acute" },
}));

test("analyze replaces Claude's medication_note with the engine's", async () => {
  const answer = { ...GOOD_ANSWER, medication_note: "Take more ibuprofen when a headache starts." };
  const { actions } = actionFakes({ answer, rows: acuteDays(9) });
  const { result, source } = await actions.analyze({ today: "2026-01-20" }, { token: "good-token" });
  assert.equal(source, "ai");
  assert.equal(result.medication_note, "You logged acute medication on 9 of the last 30 days. That is worth raising with your doctor.");
});

test("analyze shows no medication note below the flag line, whatever Claude wrote", async () => {
  const answer = { ...GOOD_ANSWER, medication_note: "Switch to naproxen." };
  const { actions } = actionFakes({ answer, rows: acuteDays(2) });
  const { result, source } = await actions.analyze({ today: "2026-01-20" }, { token: "good-token" });
  assert.equal(source, "ai");
  assert.equal(result.medication_note, null);
});

const failedTrial = (suggestion) => ({ status: "completed", suggestion, result: { before: 1, during: 2 } });

test("analyze uses the rules when Claude repeats a failed trial by key", async (t) => {
  t.mock.method(console, "error", () => {});
  const answer = { ...GOOD_ANSWER, try_next: { ...GOOD_ANSWER.try_next, title: "Go without cheddar", factor_key: "food:cheddar" } };
  const { actions } = actionFakes({ answer, trials: [failedTrial({ title: "Skip cheddar", factor_key: "food:cheddar" })] });
  const { source } = await actions.analyze({ today: "2026-01-03" }, { token: "good-token" });
  assert.equal(source, "rules");
});

test("analyze uses the rules when Claude repeats a failed trial by title", async (t) => {
  t.mock.method(console, "error", () => {});
  const { actions } = actionFakes({ trials: [failedTrial({ title: " skip CHEDDAR for 2 weeks", factor_key: null })] });
  const { source } = await actions.analyze({ today: "2026-01-03" }, { token: "good-token" });
  assert.equal(source, "rules");
});

test("analyze keeps Claude's answer when the matching trial helped or was stopped", async () => {
  const helped = { status: "completed", suggestion: { title: "Skip cheddar for 2 weeks" }, result: { before: 2, during: 1 } };
  const stopped = { status: "stopped", suggestion: { title: "Skip cheddar for 2 weeks" }, result: null };
  const { actions } = actionFakes({ trials: [helped, stopped] });
  const { source } = await actions.analyze({ today: "2026-01-03" }, { token: "good-token" });
  assert.equal(source, "ai");
});
