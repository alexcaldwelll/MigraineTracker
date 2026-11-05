import { test } from "node:test";
import assert from "node:assert/strict";
import { setBackend } from "../public/js/data.js";
import { backfillFood, pickBackfillBatch, canSendToAi, dayTotals, formatAmount, mergeItems, retryPendingSplits, splitEntry, triggerTags, visibleItems, changeEntryItems } from "../public/js/food.js";
import { FOOD_SCHEMA, validateItems } from "../netlify/functions/lib/food.js";

const item = (over = {}) => ({
  name: "cheddar", main_macro: "fat", food_type: "dairy",
  protein_g: 7, carbs_g: 1, fat_g: 9, tags: ["aged_cheese"], ...over,
});

test("validateItems drops unknown tags and maps an unknown food_type to other", () => {
  const [out] = validateItems([item({ tags: ["aged_cheese", "gluten"], food_type: "cheese" })]);
  assert.deepEqual(out.tags, ["aged_cheese"]);
  assert.equal(out.food_type, "other");
});

test("validateItems drops malformed items and never trusts edited from the model", () => {
  const out = validateItems([null, item({ name: " " }), item({ edited: true, protein_g: "x" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].edited, undefined);
  assert.equal(out[0].protein_g, 0);
  assert.deepEqual(validateItems("nope"), []);
});

test("validateItems repairs an unknown main_macro from the grams", () => {
  assert.equal(validateItems([item({ main_macro: "sugar", protein_g: 30 })])[0].main_macro, "protein");
});

test("FOOD_SCHEMA lists the allowed values", () => {
  const props = FOOD_SCHEMA.properties.items.items.properties;
  assert.equal(props.food_type.enum.length, 8);
  assert.equal(props.tags.items.enum.length, 7);
});

test("mergeItems keeps every edited item", () => {
  const edited = [item({ name: "my bread", edited: true }), item({ name: "mine", edited: true })];
  const merged = mergeItems([...edited, item({ name: "old" })], [item({ name: "new" })]);
  assert.deepEqual(merged.map((i) => i.name), ["my bread", "mine", "new"]);
});

test("mergeItems drops an incoming item that repeats an edited one", () => {
  const merged = mergeItems([item({ name: "Cheddar", edited: true })], [item(), item({ name: "toast" })]);
  assert.deepEqual(merged.map((i) => i.name), ["Cheddar", "toast"]);
});

test("canSendToAi needs ai_notice_seen_at", () => {
  assert.equal(canSendToAi(null), false);
  assert.equal(canSendToAi({ ai_notice_seen_at: null }), false);
  assert.equal(canSendToAi({ ai_notice_seen_at: "2026-11-05T00:00:00Z" }), true);
});

// An in-memory day. `rows` is what listDay returns; update writes back into it.
function fakeBackend({ settings, ai, rows }) {
  const backend = {
    updates: [], aiCalls: [], rows: rows || [{ id: "r1", type: "food", time: "08:00", text: "cheddar toast", split_status: "pending" }],
    listDay: async () => backend.rows.map((r) => ({ ...r })),
    update: async (id, date, entry) => {
      backend.updates.push({ id, date, entry });
      backend.rows = backend.rows.map((r) => (r.id === id ? { id, ...entry } : r));
    },
    getSettings: async () => settings,
    ai: async (action, payload) => { backend.aiCalls.push([action, payload]); return ai(); },
  };
  setBackend(backend);
  return backend;
}
const stored = { id: "r1", type: "food", time: "08:00", text: "cheddar toast", split_status: "pending" };
const OK = { ai_notice_seen_at: "x" };

test("splitEntry with a failing backend keeps text and sets failed", async (t) => {
  t.mock.method(console, "error", () => {});
  const b = fakeBackend({ settings: OK, ai: async () => { throw new Error("down"); } });
  await splitEntry("2026-11-05", stored);
  const last = b.updates.at(-1);
  assert.equal(last.entry.split_status, "failed");
  assert.equal(last.entry.text, "cheddar toast");
  assert.equal("id" in last.entry, false);
});

test("splitEntry makes no AI call without the notice, and stays pending", async () => {
  const b = fakeBackend({ settings: { ai_notice_seen_at: null }, ai: async () => ({ items: [] }) });
  await splitEntry("2026-11-05", stored);
  assert.deepEqual(b.aiCalls, []);
  assert.deepEqual(b.updates, []);
});

test("splitEntry saves items, keeps edited ones, and writes no id or date into data", async () => {
  const edited = item({ name: "mine", edited: true });
  const row = { ...stored, items: [edited] };
  const b = fakeBackend({ settings: OK, ai: async () => ({ items: [item()] }), rows: [row] });
  await splitEntry("2026-11-05", { ...row, date: "2026-11-05" });
  assert.deepEqual(b.aiCalls, [["split_food", { text: "cheddar toast" }]]);
  const { id, date, entry } = b.updates.at(-1);
  assert.equal(id, "r1");
  assert.equal(date, "2026-11-05");
  assert.equal(entry.split_status, "done");
  assert.deepEqual(entry.items.map((i) => i.name), ["mine", "cheddar"]);
  assert.equal("id" in entry || "date" in entry, false);
});

test("splitEntry never rejects, even if saving fails", async (t) => {
  t.mock.method(console, "error", () => {});
  setBackend({ update: async () => { throw new Error("db"); }, getSettings: async () => { throw new Error("db"); } });
  await splitEntry("2026-11-05", { ...stored, split_status: "failed" });
});

test("splitEntry does not write when the text was edited during the AI call", async () => {
  const b = fakeBackend({ settings: OK, ai: async () => {
    b.rows = [{ ...b.rows[0], text: "oatmeal", split_status: "pending" }];   // the person edits mid-call
    return { items: [item()] };
  } });
  await splitEntry("2026-11-05", stored);
  assert.equal(b.rows[0].text, "oatmeal");
  assert.equal(b.rows[0].items, undefined);
  assert.equal(b.updates.every((u) => u.entry.split_status === "pending"), true);
});

test("splitEntry does not write when the entry was deleted during the AI call", async () => {
  const b = fakeBackend({ settings: OK, ai: async () => { b.rows = []; return { items: [item()] }; } });
  await splitEntry("2026-11-05", stored);
  assert.deepEqual(b.rows, []);
  assert.equal(b.updates.length, 0);
});

test("splitEntry does not write a failed status over an edited text either", async (t) => {
  t.mock.method(console, "error", () => {});
  const b = fakeBackend({ settings: OK, ai: async () => {
    b.rows = [{ ...b.rows[0], text: "oatmeal" }];
    throw new Error("down");
  } });
  await splitEntry("2026-11-05", stored);
  assert.equal(b.rows[0].split_status, "pending");
});

test("splitEntry keeps an item the person changed during the AI call", async () => {
  const b = fakeBackend({ settings: OK, ai: async () => {
    b.rows = [{ ...b.rows[0], items: [item({ name: "mine", edited: true })] }];
    return { items: [item()] };
  } });
  await splitEntry("2026-11-05", stored);
  assert.deepEqual(b.rows[0].items.map((i) => i.name), ["mine", "cheddar"]);
});

test("formatAmount marks estimates with ~", () => {
  assert.equal(formatAmount(9, "fat"), "~9g fat");
  assert.equal(formatAmount(24.4, "protein"), "~24g protein");
  assert.equal(formatAmount(30, "carbs"), "~30g carbs");
  assert.equal(formatAmount(7), "~7g");
});

test("dayTotals sums visible items across entries and ignores pending ones", () => {
  const entries = [
    { type: "food", split_status: "done", items: [item(), item({ name: "toast", protein_g: 3, carbs_g: 20, fat_g: 1 })] },
    { type: "food", split_status: "pending", items: [item({ protein_g: 100 })] },
    { type: "food", split_status: "done", items: [item({ name: "gone", protein_g: 50, edited: true, removed: true })] },
    { type: "food", text: "old plain entry" },
    { type: "sleep", hours: 8 },
  ];
  assert.deepEqual(dayTotals(entries), { protein_g: 10, carbs_g: 21, fat_g: 10 });
  assert.deepEqual(dayTotals([]), { protein_g: 0, carbs_g: 0, fat_g: 0 });
});

test("triggerTags returns unique tags from visible, non-pending items", () => {
  const entries = [
    { type: "food", split_status: "done", items: [item(), item({ name: "coffee", tags: ["caffeine", "aged_cheese"] })] },
    { type: "food", split_status: "pending", items: [item({ tags: ["msg"] })] },
    { type: "food", split_status: "done", items: [item({ tags: ["alcohol"], edited: true, removed: true })] },
    { type: "food", text: "plain" },
  ];
  assert.deepEqual(triggerTags(entries), ["aged_cheese", "caffeine"]);
});

test("a removed item stays removed after a re-split", () => {
  const removed = item({ name: "Cheddar", edited: true, removed: true });
  const merged = mergeItems([removed], [item(), item({ name: "toast" })]);
  assert.deepEqual(visibleItems(merged).map((i) => i.name), ["toast"]);
});

test("changeEntryItems edits, adds and removes, marking each edited", async () => {
  const row = { id: "r1", type: "food", time: "08:00", text: "x", split_status: "done", items: [item(), item({ name: "toast" })] };
  const b = fakeBackend({ settings: OK, ai: async () => ({}), rows: [row] });
  await changeEntryItems("2026-11-05", "r1", { index: 0, name: "cheddar", item: item({ name: "sharp cheddar" }) });
  assert.deepEqual(b.rows[0].items[0], { ...item({ name: "sharp cheddar" }), edited: true });
  await changeEntryItems("2026-11-05", "r1", { item: item({ name: "pickle" }) });
  assert.equal(b.rows[0].items.at(-1).edited, true);
  await changeEntryItems("2026-11-05", "r1", { index: 1, name: "toast", item: null });
  assert.deepEqual(visibleItems(b.rows[0].items).map((i) => i.name), ["sharp cheddar", "pickle"]);
  assert.equal(b.rows[0].items[1].removed, true);
  assert.equal("id" in b.updates.at(-1).entry, false);
});

test("changeEntryItems does nothing when the entry is gone", async () => {
  const b = fakeBackend({ settings: OK, ai: async () => ({}), rows: [] });
  assert.equal(await changeEntryItems("2026-11-05", "r1", { item: item() }), false);
  assert.equal(b.updates.length, 0);
});

// ---- app-open retry ----
const NOW = new Date(2026, 10, 5, 9, 0);   // Nov 5, local
const pend = (id) => ({ id, type: "food", time: "08:00", text: "t" + id, split_status: "pending" });
function daysBackend(entriesByDate) {
  const calls = [];
  const rows = Object.values(entriesByDate).flat();
  const b = fakeBackend({ settings: OK, rows, ai: async () => ({ items: [] }) });
  b.listDay = async (date) => (entriesByDate[date] || []).map((r) => ({ ...r }));
  b.update = async (id, date, entry) => { calls.push({ id, date, status: entry.split_status }); };
  b.calls = calls;
  return b;
}

test("retryPendingSplits covers the last 7 days only", async () => {
  const byDate = { "2026-11-05": [pend("a")], "2026-10-29": [pend("b")], "2026-10-28": [pend("c")] };
  const b = daysBackend(byDate);
  const days = Object.entries(byDate).map(([date, entries]) => ({ date, entries }));
  const n = await retryPendingSplits(days, NOW);
  assert.equal(n, 2);
  assert.deepEqual(b.aiCalls.map((c) => c[1].text).sort(), ["ta", "tb"]);
});

test("retryPendingSplits does at most 5, one at a time, newest first", async () => {
  const byDate = {};
  for (let i = 0; i < 7; i++) byDate["2026-11-0" + (i % 5 + 1)] = [...(byDate["2026-11-0" + (i % 5 + 1)] || []), pend("p" + i)];
  const b = daysBackend(byDate);
  let running = 0, peak = 0;
  b.ai = async (a, payload) => { running++; peak = Math.max(peak, running); b.aiCalls.push([a, payload]); await new Promise((r) => setImmediate(r)); running--; return { items: [] }; };
  const days = Object.entries(byDate).map(([date, entries]) => ({ date, entries }));
  assert.equal(await retryPendingSplits(days, NOW), 5);
  assert.equal(b.aiCalls.length, 5);
  assert.equal(peak, 1);
});

test("retryPendingSplits takes failed entries as well, skips old ones, and does nothing without the notice", async () => {
  const failed = { ...pend("f"), split_status: "failed" };
  const legacy = { id: "l", type: "food", time: "08:00", text: "old" };
  const done = { ...pend("d"), split_status: "done" };
  const b = daysBackend({ "2026-11-05": [failed, legacy, done, pend("a")] });
  const days = [{ date: "2026-11-05", entries: [failed, legacy, done, pend("a")] }];
  assert.equal(await retryPendingSplits(days, NOW), 2);
  assert.deepEqual(b.aiCalls.map((c) => c[1].text).sort(), ["ta", "tf"]);
  setBackend({ ...b, getSettings: async () => ({ ai_notice_seen_at: null }) });
  assert.equal(await retryPendingSplits(days, NOW), 0);
});

test("a failed entry that sorts on retry stops being failed", async () => {
  const failed = { ...pend("f"), split_status: "failed" };
  const b = daysBackend({ "2026-11-05": [failed] });
  await retryPendingSplits([{ date: "2026-11-05", entries: [failed] }], NOW);
  assert.equal(b.calls.at(-1).status, "done");
});

test("failed and pending entries share the limit of 5 an open", async () => {
  const entries = [];
  for (let i = 0; i < 8; i++) entries.push({ ...pend("p" + i), split_status: i % 2 ? "failed" : "pending" });
  const b = daysBackend({ "2026-11-05": entries });
  assert.equal(await retryPendingSplits([{ date: "2026-11-05", entries }], NOW), 5);
  assert.equal(b.aiCalls.length, 5);
});

test("a failed entry older than 7 days waits for its Retry button", async () => {
  const entries = [{ ...pend("f"), split_status: "failed" }];
  daysBackend({ "2026-10-28": entries });
  assert.equal(await retryPendingSplits([{ date: "2026-10-28", entries }], NOW), 0);
  assert.deepEqual(pickBackfillBatch([{ date: "2026-10-28", entries }], 10, NOW), []);
});

// ---- backfill of old entries ----
const old = (id, extra = {}) => ({ id, type: "food", time: "08:00", text: "t" + id, ...extra });
const oldDays = (byDate) => Object.entries(byDate).map(([date, entries]) => ({ date, entries }));

test("pickBackfillBatch takes newest unsplit entries, skips split, pending, failed and edited, max 10", () => {
  const days = oldDays({
    "2026-11-01": [old("a")],
    "2026-11-03": [old("b", { time: "07:00" }), old("c", { time: "19:00" }), old("p", { split_status: "pending" }), old("f", { split_status: "failed" }), old("d", { split_status: "done", items: [item()] }), old("e", { items: [item({ edited: true })] }), { id: "n", type: "note", text: "x" }],
  });
  const batch = pickBackfillBatch(days, undefined, NOW);
  assert.deepEqual(batch.map((e) => e.id), ["c", "b", "a"]);
  assert.equal(batch[0].date, "2026-11-03");
  const many = oldDays({ "2026-10-01": Array.from({ length: 15 }, (_, i) => old("m" + i)) });
  assert.equal(pickBackfillBatch(many).length, 10);
  assert.equal(pickBackfillBatch(many, 3).length, 3);
});

test("backfill splits quietly: no pending write, uses backfill_food, keeps bracketed text", async () => {
  const text = "eggs, toast (420 cal, 30g protein, 40g carbs, 12g fat)";
  const row = old("r1", { text });
  const b = fakeBackend({ settings: OK, rows: [row], ai: async () => ({ items: [item()] }) });
  const n = await backfillFood([{ date: "2026-11-01", entries: [row] }]);
  assert.equal(n, 1);
  assert.deepEqual(b.aiCalls, [["backfill_food", { text }]]);
  assert.equal(b.updates.length, 1);
  assert.equal(b.updates[0].entry.split_status, "done");
  assert.equal(b.updates[0].entry.text, text);
  assert.equal("date" in b.updates[0].entry, false);
});

test("backfill stops quietly on 429 and writes nothing", async () => {
  const rows = [old("a"), old("b"), old("c")];
  const b = fakeBackend({ settings: OK, rows, ai: async () => { throw Object.assign(new Error("limit"), { status: 429 }); } });
  const n = await backfillFood([{ date: "2026-11-01", entries: rows }]);
  assert.equal(n, 0);
  assert.equal(b.aiCalls.length, 1);
  assert.equal(b.updates.length, 0);
});

test("backfill leaves an entry alone on other failures and carries on", async () => {
  const rows = [old("a", { time: "09:00" }), old("b", { time: "08:00" })];
  let calls = 0;
  const b = fakeBackend({ settings: OK, rows, ai: async () => { if (calls++ === 0) throw new Error("down"); return { items: [item()] }; } });
  assert.equal(await backfillFood([{ date: "2026-11-01", entries: rows }]), 1);
  assert.equal(b.updates.length, 1);
  assert.equal(b.updates[0].id, "b");
});

test("backfill does nothing without the notice, and runs one request at a time", async () => {
  const rows = [old("a"), old("b"), old("c")];
  const b = fakeBackend({ settings: { ai_notice_seen_at: null }, rows, ai: async () => ({ items: [] }) });
  assert.equal(await backfillFood([{ date: "2026-11-01", entries: rows }]), 0);
  assert.equal(b.aiCalls.length, 0);
  let running = 0, peak = 0;
  const b2 = fakeBackend({ settings: OK, rows, ai: async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setImmediate(r)); running--; return { items: [] }; } });
  assert.equal(await backfillFood([{ date: "2026-11-01", entries: rows }]), 3);
  assert.equal(peak, 1);
  assert.equal(b2.aiCalls.length, 3);
});

// ---- pending entries past the retry window ----
test("backfill picks pending entries only once the retry pass has stopped covering them", () => {
  const entries = (date) => ({ date, entries: [old(date, { split_status: "pending" })] });
  const batch = pickBackfillBatch([entries("2026-10-29"), entries("2026-10-28"), entries("2026-11-05")], 10, NOW);
  assert.deepEqual(batch.map((e) => e.date), ["2026-10-28"]);
});

test("an old pending entry with edited items is still picked, and the edit survives", async () => {
  const edited = { name: "my toast", main_macro: "carbs", food_type: "grains", tags: [], edited: true };
  const row = old("p", { split_status: "pending", items: [edited] });
  const b = fakeBackend({ settings: OK, rows: [row], ai: async () => ({ items: [item()] }) });
  assert.equal(await backfillFood([{ date: "2026-10-01", entries: [row] }], 10, NOW), 1);
  assert.equal(b.aiCalls[0][0], "backfill_food");
  assert.equal(b.updates.length, 1);
  assert.equal(b.updates[0].entry.split_status, "done");
  assert.deepEqual(b.updates[0].entry.items.map((i) => i.name), ["my toast", "cheddar"]);
});

test("backfill writes nothing when an old pending entry fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const row = old("p", { split_status: "pending" });
  const b = fakeBackend({ settings: OK, rows: [row], ai: async () => { throw new Error("down"); } });
  assert.equal(await backfillFood([{ date: "2026-10-01", entries: [row] }], 10, NOW), 0);
  assert.deepEqual(b.updates, []);
});
