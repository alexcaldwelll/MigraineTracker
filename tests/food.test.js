import { test } from "node:test";
import assert from "node:assert/strict";
import { setBackend } from "../public/js/data.js";
import { canSendToAi, mergeItems, splitEntry } from "../public/js/food.js";
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

function fakeBackend({ settings, ai }) {
  const backend = {
    updates: [], aiCalls: [],
    update: async (id, date, entry) => { backend.updates.push({ id, date, entry }); },
    getSettings: async () => settings,
    ai: async (action, payload) => { backend.aiCalls.push([action, payload]); return ai(); },
  };
  setBackend(backend);
  return backend;
}
const stored = { id: "r1", type: "food", time: "08:00", text: "cheddar toast", split_status: "pending" };

test("splitEntry with a failing backend keeps text and sets failed", async (t) => {
  t.mock.method(console, "error", () => {});
  const b = fakeBackend({ settings: { ai_notice_seen_at: "x" }, ai: async () => { throw new Error("down"); } });
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
  const b = fakeBackend({ settings: { ai_notice_seen_at: "x" }, ai: async () => ({ items: [item()] }) });
  await splitEntry("2026-11-05", { ...stored, items: [edited], date: "2026-11-05" });
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
