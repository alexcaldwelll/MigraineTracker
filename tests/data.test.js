import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupabaseBackend, setBackend, data, emptyOnError } from "../public/js/data.js";

// A chainable stand-in for supabase-js. Every query records its method calls,
// and awaiting it asks `respond` for the { data, error } result.
function fakeClient(respond = () => ({ data: null, error: null })) {
  const queries = [];
  return {
    queries,
    from(table) {
      const query = { table, ops: [] };
      queries.push(query);
      const builder = new Proxy({}, {
        get(_, name) {
          if (name === "then") {
            return (resolve, reject) => Promise.resolve(respond(query)).then(resolve, reject);
          }
          return (...args) => {
            query.ops.push([name, ...args]);
            return builder;
          };
        },
      });
      return builder;
    },
  };
}

const op = (query, name) => query.ops.find((o) => o[0] === name);

function pagedRows(total) {
  return Array.from({ length: total }, (_, i) => ({
    id: `id-${i}`,
    date: `2026-01-${String(28 - (i % 28)).padStart(2, "0")}`,
    time: "08:00",
    type: "food",
    data: { text: `meal ${i}` },
  }));
}

function pagingClient(rows) {
  return fakeClient((query) => {
    const [, from, to] = op(query, "range");
    return { data: rows.slice(from, to + 1), error: null };
  });
}

const FAILURE = { message: "database down" };

// ---------- setBackend / data ----------

test("data() returns the backend given to setBackend", () => {
  const backend = {};
  setBackend(backend);
  assert.equal(data(), backend);
});

test("emptyOnError passes results through and turns a failure into an empty list", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.deepEqual(await emptyOnError(Promise.resolve([1])), [1]);
  assert.deepEqual(await emptyOnError(Promise.reject(new Error("no"))), []);
});

// ---------- listAll ----------

test("listAll keeps requesting ranges until a page comes back short", async () => {
  const client = pagingClient(pagedRows(2350));
  const days = await createSupabaseBackend(client).listAll();
  assert.deepEqual(client.queries.map((q) => op(q, "range").slice(1)), [
    [0, 999],
    [1000, 1999],
    [2000, 2999],
  ]);
  assert.equal(days.flatMap((d) => d.entries).length, 2350);
});

test("listAll requests one more page when the rows end exactly on a page boundary", async () => {
  const client = pagingClient(pagedRows(2000));
  const days = await createSupabaseBackend(client).listAll();
  assert.equal(client.queries.length, 3);
  assert.equal(days.flatMap((d) => d.entries).length, 2000);
});

test("listAll stops after one short page", async () => {
  const client = pagingClient(pagedRows(5));
  await createSupabaseBackend(client).listAll();
  assert.equal(client.queries.length, 1);
});

test("listAll sorts newest first and ends on the unique id, so pages cannot overlap", async () => {
  const client = pagingClient(pagedRows(5));
  await createSupabaseBackend(client).listAll();
  const orders = client.queries[0].ops.filter((o) => o[0] === "order");
  assert.deepEqual(orders[0].slice(1), ["date", { ascending: false }]);
  assert.equal(orders.at(-1)[1], "id");
});

test("listAll keeps the [{date, entries}] shape with data fields spread on each entry", async () => {
  const client = fakeClient(() => ({
    data: [
      { id: "a", date: "2026-02-02", time: "09:00", type: "food", data: { text: "toast" }, user_id: "u" },
      { id: "b", date: "2026-02-02", time: "10:00", type: "hydration", data: { amount: 8 } },
      { id: "c", date: "2026-02-01", time: null, type: "note", data: { text: "hi" } },
    ],
    error: null,
  }));
  assert.deepEqual(await createSupabaseBackend(client).listAll(), [
    {
      date: "2026-02-02",
      entries: [
        { id: "a", type: "food", time: "09:00", text: "toast" },
        { id: "b", type: "hydration", time: "10:00", amount: 8 },
      ],
    },
    { date: "2026-02-01", entries: [{ id: "c", type: "note", time: null, text: "hi" }] },
  ]);
});

test("listAll rejects when a later page fails, rather than returning part of the log", async () => {
  const rows = pagedRows(1500);
  const client = fakeClient((query) => {
    const [, from, to] = op(query, "range");
    return from === 0 ? { data: rows.slice(from, to + 1), error: null } : { data: null, error: FAILURE };
  });
  await assert.rejects(createSupabaseBackend(client).listAll(), /database down/);
});

// ---------- Entries ----------

test("listDay filters to the date, sorts by time and flattens rows", async () => {
  const client = fakeClient(() => ({
    data: [{ id: "a", date: "2026-02-02", time: "09:00", type: "food", data: { text: "toast" } }],
    error: null,
  }));
  const entries = await createSupabaseBackend(client).listDay("2026-02-02");
  assert.deepEqual(entries, [{ id: "a", type: "food", time: "09:00", text: "toast" }]);
  const [query] = client.queries;
  assert.equal(query.table, "entries");
  assert.deepEqual(op(query, "eq").slice(1), ["date", "2026-02-02"]);
  assert.deepEqual(op(query, "order").slice(1), ["time", { ascending: true }]);
});

test("add stores type and time in columns and everything else in data", async () => {
  const client = fakeClient();
  await createSupabaseBackend(client).add("2026-02-02", { type: "food", time: "09:00", text: "toast" });
  assert.deepEqual(op(client.queries[0], "insert").slice(1), [
    { date: "2026-02-02", time: "09:00", type: "food", data: { text: "toast" } },
  ]);
});

test("add returns the new row id", async () => {
  const client = fakeClient(() => ({ data: { id: "new-id" }, error: null }));
  assert.equal(await createSupabaseBackend(client).add("2026-02-02", { type: "food", time: "09:00" }), "new-id");
});

test("update writes the row with that id", async () => {
  const client = fakeClient();
  await createSupabaseBackend(client).update("a", "2026-02-03", { type: "note", time: "10:00", text: "x" });
  const [query] = client.queries;
  assert.deepEqual(op(query, "update").slice(1), [
    { date: "2026-02-03", time: "10:00", type: "note", data: { text: "x" } },
  ]);
  assert.deepEqual(op(query, "eq").slice(1), ["id", "a"]);
});

test("remove deletes the row with that id", async () => {
  const client = fakeClient();
  await createSupabaseBackend(client).remove("a");
  const [query] = client.queries;
  assert.ok(op(query, "delete"));
  assert.deepEqual(op(query, "eq").slice(1), ["id", "a"]);
});

// ---------- Meds ----------

test("listMeds returns the catalog oldest first", async () => {
  const meds = [{ id: "m", name: "Magnesium", category: "supplement", default_dose: null }];
  const client = fakeClient(() => ({ data: meds, error: null }));
  assert.deepEqual(await createSupabaseBackend(client).listMeds(), meds);
  assert.equal(client.queries[0].table, "meds_catalog");
  assert.deepEqual(op(client.queries[0], "order").slice(1), ["created_at", { ascending: true }]);
});

test("addMed inserts the med and removeMed deletes by id", async () => {
  const client = fakeClient();
  const backend = createSupabaseBackend(client);
  const med = { name: "Magnesium", category: "supplement", default_dose: "400mg" };
  await backend.addMed(med);
  await backend.removeMed("m");
  assert.deepEqual(op(client.queries[0], "insert").slice(1), [med]);
  assert.ok(op(client.queries[1], "delete"));
  assert.deepEqual(op(client.queries[1], "eq").slice(1), ["id", "m"]);
});

// ---------- Settings ----------

test("getSettings returns the row, or null for someone with no row yet", async () => {
  const row = { password_set_at: "2026-01-01T00:00:00Z" };
  assert.deepEqual(
    await createSupabaseBackend(fakeClient(() => ({ data: row, error: null }))).getSettings(),
    row,
  );
  assert.equal(await createSupabaseBackend(fakeClient()).getSettings(), null);
});

test("saveSettings upserts only the patch, so other settings keep their values", async () => {
  const client = fakeClient();
  const patch = { password_set_at: "2026-01-01T00:00:00Z" };
  await createSupabaseBackend(client).saveSettings(patch);
  assert.equal(client.queries[0].table, "user_settings");
  assert.deepEqual(op(client.queries[0], "upsert").slice(1), [patch]);
});

// ---------- Insights and trials ----------

test("getInsight returns the saved result and when it was made, or null", async () => {
  const row = { result: { try_next: {} }, created_at: "2026-01-01T00:00:00Z" };
  const client = fakeClient(() => ({ data: row, error: null }));
  assert.deepEqual(await createSupabaseBackend(client).getInsight(), row);
  assert.equal(client.queries[0].table, "insights");
  assert.equal(await createSupabaseBackend(fakeClient()).getInsight(), null);
});

test("saveInsight upserts the result with a fresh created_at", async () => {
  const client = fakeClient();
  await createSupabaseBackend(client).saveInsight({ try_next: {} });
  const [, row] = op(client.queries[0], "upsert");
  assert.equal(client.queries[0].table, "insights");
  assert.deepEqual(row.result, { try_next: {} });
  assert.ok(!Number.isNaN(Date.parse(row.created_at)));
});

test("listTrials returns trials newest first", async () => {
  const trials = [{ id: "t", status: "active" }];
  const client = fakeClient(() => ({ data: trials, error: null }));
  assert.deepEqual(await createSupabaseBackend(client).listTrials(), trials);
  assert.equal(client.queries[0].table, "trials");
  assert.deepEqual(op(client.queries[0], "order").slice(1), ["created_at", { ascending: false }]);
});

test("saveTrial upserts by id and returns the stored row", async () => {
  const stored = { id: "t", status: "active" };
  const client = fakeClient(() => ({ data: stored, error: null }));
  const trial = { suggestion: {}, start_date: "2026-01-01", end_date: "2026-01-14", status: "active" };
  assert.deepEqual(await createSupabaseBackend(client).saveTrial(trial), stored);
  assert.equal(client.queries[0].table, "trials");
  assert.deepEqual(op(client.queries[0], "upsert").slice(1), [trial]);
});

// ---------- Failures ----------

test("every database method rejects when Supabase reports an error", async () => {
  const backend = createSupabaseBackend(fakeClient(() => ({ data: null, error: FAILURE })));
  const calls = {
    listDay: () => backend.listDay("2026-01-01"),
    listAll: () => backend.listAll(),
    add: () => backend.add("2026-01-01", { type: "note", time: "09:00" }),
    update: () => backend.update("a", "2026-01-01", { type: "note", time: "09:00" }),
    remove: () => backend.remove("a"),
    listMeds: () => backend.listMeds(),
    addMed: () => backend.addMed({ name: "x" }),
    removeMed: () => backend.removeMed("m"),
    getSettings: () => backend.getSettings(),
    saveSettings: () => backend.saveSettings({}),
    getInsight: () => backend.getInsight(),
    saveInsight: () => backend.saveInsight({}),
    listTrials: () => backend.listTrials(),
    saveTrial: () => backend.saveTrial({}),
  };
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(call(), /database down/, name);
  }
});

// ---------- ai ----------

function aiClient({ session = { access_token: "old" }, refreshed = { access_token: "new" }, refreshError = null } = {}) {
  let refreshes = 0;
  return {
    get refreshes() { return refreshes; },
    auth: {
      getSession: async () => ({ data: { session } }),
      refreshSession: async () => {
        refreshes += 1;
        return { data: { session: refreshed }, error: refreshError };
      },
    },
  };
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status });

function mockFetch(t, ...responses) {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => responses.shift());
  return (i) => fetchMock.mock.calls[i].arguments;
}

test("ai posts the action and payload with the session token", async (t) => {
  const argsOf = mockFetch(t, jsonResponse(200, { text: "hi" }));
  const out = await createSupabaseBackend(aiClient()).ai("analyze", { a: 1 });
  assert.deepEqual(out, { text: "hi" });
  const [url, init] = argsOf(0);
  assert.equal(url, "/.netlify/functions/ai");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer old");
  assert.deepEqual(JSON.parse(init.body), { action: "analyze", payload: { a: 1 } });
});

test("ai refreshes the session and retries once after a 401", async (t) => {
  const argsOf = mockFetch(t, jsonResponse(401, {}), jsonResponse(200, { text: "ok" }));
  const client = aiClient();
  assert.deepEqual(await createSupabaseBackend(client).ai("analyze", {}), { text: "ok" });
  assert.equal(client.refreshes, 1);
  assert.equal(argsOf(1)[1].headers.Authorization, "Bearer new");
});

test("ai does not retry a second time", async (t) => {
  mockFetch(t, jsonResponse(401, { error: "Still no." }), jsonResponse(401, { error: "Still no." }));
  const client = aiClient();
  await assert.rejects(createSupabaseBackend(client).ai("analyze", {}), /Still no\./);
  assert.equal(globalThis.fetch.mock.callCount(), 2);
  assert.equal(client.refreshes, 1);
});

test("ai asks the person to sign in again with no session or a failed refresh", async (t) => {
  mockFetch(t, jsonResponse(401, {}));
  await assert.rejects(createSupabaseBackend(aiClient({ session: null })).ai("analyze", {}), /sign in again/);
  await assert.rejects(
    createSupabaseBackend(aiClient({ refreshError: { message: "x" } })).ai("analyze", {}),
    /sign in again/,
  );
});

test("ai surfaces the server's error, with a fallback for unreadable bodies", async (t) => {
  mockFetch(t, jsonResponse(429, { error: "Daily limit reached." }), new Response("not json", { status: 500 }));
  const backend = createSupabaseBackend(aiClient());
  await assert.rejects(backend.ai("analyze", {}), /Daily limit reached\./);
  await assert.rejects(backend.ai("analyze", {}), /unavailable/);
});
