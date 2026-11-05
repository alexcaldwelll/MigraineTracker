import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setBackend } from "../public/js/data.js";
import { submitEntry, commitDraft, initForms, openEditSheet, openSheet } from "../public/js/forms.js";
import { FakeElement, fakePage } from "./fake-page.js";
import { tileStatus } from "../public/js/today.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const components = readFileSync(new URL("../public/css/components.css", import.meta.url), "utf8");
const base = readFileSync(new URL("../public/css/base.css", import.meta.url), "utf8");

const food = { type: "food", time: "08:10", text: "eggs and toast" };

// Records calls and fails while `down` is true, like a dropped connection.
function fakeBackend() {
  const backend = {
    down: false,
    added: [],
    updated: [],
    async add(date, entry) {
      if (backend.down) throw new Error("Failed to fetch");
      backend.added.push({ date, entry });
    },
    async update(id, date, entry) {
      if (backend.down) throw new Error("Failed to fetch");
      backend.updated.push({ id, date, entry });
    },
  };
  setBackend(backend);
  return backend;
}

// Stands in for the sheet's fields. Clearing is the only way to lose the text.
function fakeDraft() {
  const draft = { text: "eggs and toast", clear() { draft.text = ""; } };
  return draft;
}

// ---------- submitEntry ----------
test("submitEntry reports success and stores the entry", async () => {
  const backend = fakeBackend();
  assert.deepEqual(await submitEntry("2026-11-04", food), { ok: true });
  assert.deepEqual(backend.added, [{ date: "2026-11-04", entry: food }]);
});

test("submitEntry resolves with the error instead of rejecting when the backend fails", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeBackend().down = true;
  assert.deepEqual(await submitEntry("2026-11-04", food), { ok: false, error: "Failed to fetch" });
});

test("submitEntry still gives a message when the failure has none", async (t) => {
  t.mock.method(console, "error", () => {});
  setBackend({ add: () => Promise.reject({}) });
  const result = await submitEntry("2026-11-04", food);
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

// ---------- commitDraft decides whether the draft is cleared ----------
test("a rejected save keeps everything the person entered", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeBackend().down = true;
  const draft = fakeDraft();
  const result = await commitDraft({ date: "2026-11-04", entry: food }, draft.clear);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Failed to fetch");
  assert.equal(draft.text, "eggs and toast");
});

test("a successful save clears the draft", async () => {
  fakeBackend();
  const draft = fakeDraft();
  const result = await commitDraft({ date: "2026-11-04", entry: food }, draft.clear);
  assert.deepEqual(result, { ok: true });
  assert.equal(draft.text, "");
});

test("retrying after a failure saves once and only then clears", async (t) => {
  t.mock.method(console, "error", () => {});
  const backend = fakeBackend();
  const draft = fakeDraft();
  backend.down = true;
  await commitDraft({ date: "2026-11-04", entry: food }, draft.clear);
  backend.down = false;
  await commitDraft({ date: "2026-11-04", entry: food }, draft.clear);
  assert.equal(backend.added.length, 1);
  assert.equal(draft.text, "");
});

test("an edit updates the existing entry rather than adding one", async () => {
  const backend = fakeBackend();
  const draft = fakeDraft();
  await commitDraft({ id: "abc", date: "2026-11-04", entry: food }, draft.clear);
  assert.deepEqual(backend.updated, [{ id: "abc", date: "2026-11-04", entry: food }]);
  assert.equal(backend.added.length, 0);
  assert.equal(draft.text, "");
});

test("a failed edit keeps the draft too", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeBackend().down = true;
  const draft = fakeDraft();
  const result = await commitDraft({ id: "abc", date: "2026-11-04", entry: food }, draft.clear);
  assert.equal(result.ok, false);
  assert.equal(draft.text, "eggs and toast");
});

// ---------- tileStatus ----------
const catalog = [
  { name: "Topiramate", category: "preventive" },
  { name: "Magnesium", category: "supplement" },
];

test("meds status counts catalog meds taken", () => {
  const entries = [{ type: "meds", name: "Topiramate", category: "preventive" }];
  assert.equal(tileStatus("meds", entries, catalog), "1 of 2 taken");
});

test("meds status counts a med taken twice once, and ignores case", () => {
  const entries = [{ type: "meds", name: "topiramate" }, { type: "meds", name: "Topiramate" }];
  assert.equal(tileStatus("meds", entries, catalog), "1 of 2 taken");
});

test("meds status does not count rescue meds as something still to take", () => {
  const withRescue = [...catalog, { name: "Sumatriptan", category: "acute" }];
  assert.equal(tileStatus("meds", [], withRescue), "0 of 2 taken");
  const entries = [{ type: "meds", name: "Sumatriptan" }, { type: "meds", name: "Magnesium" }];
  assert.equal(tileStatus("meds", entries, withRescue), "1 of 2 taken");
});

test("meds status falls back to a count when nothing is scheduled", () => {
  const entries = [{ type: "meds", name: "Ibuprofen" }];
  assert.equal(tileStatus("meds", entries, []), "1 today");
  assert.equal(tileStatus("meds", [], []), "None yet");
  assert.equal(tileStatus("meds", entries, [{ name: "Sumatriptan", category: "acute" }]), "1 today");
});

test("sleep status shows hours", () => {
  assert.equal(tileStatus("sleep", [{ type: "sleep", hours: 6.5 }], []), "6.5 hrs");
});

test("sleep status adds a nap to the night without float noise", () => {
  const entries = [{ type: "sleep", hours: 6.1 }, { type: "sleep", hours: 1.2 }];
  assert.equal(tileStatus("sleep", entries, []), "7.3 hrs");
});

test("sleep status handles entries with no hours and days with no sleep", () => {
  assert.equal(tileStatus("sleep", [{ type: "sleep", hours: null, quality: "poor" }], []), "Logged");
  assert.equal(tileStatus("sleep", [{ type: "food", text: "toast" }], []), "Not logged");
});

test("food status counts only food", () => {
  const entries = [food, food, { type: "sleep", hours: 7 }];
  assert.equal(tileStatus("food", entries, []), "2 today");
  assert.equal(tileStatus("food", [], []), "None yet");
});

test("counts do not say 'today' on another day", () => {
  assert.equal(tileStatus("food", [food], [], false), "1 logged");
  assert.equal(tileStatus("meds", [{ type: "meds", name: "Ibuprofen" }], [], false), "1 logged");
});

test("the More tile names what it holds", () => {
  assert.equal(tileStatus("more", [], []), "water, period…");
});

// ---------- Today markup ----------
test("Food, Sleep, Meds and More are real buttons, after the headache button", () => {
  const tiles = [...html.matchAll(/<button[^>]*class="tile"[^>]*data-sheet="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tiles, ["food", "sleep", "meds", "more"]);
  assert.ok(html.indexOf('id="headacheBtn"') < html.indexOf('class="tile"'));
  assert.ok(html.indexOf('class="tile"') < html.indexOf("Logged today"));
});

test("the More list holds the five other types in order", () => {
  const items = [...html.matchAll(/<button[^>]*data-more="([^"]+)"[^>]*>(?:(?!<\/button>).)*<span>([^<]+)<\/span>/g)]
    .map((m) => [m[1], m[2]]);
  assert.deepEqual(items, [
    ["hydration", "Water"],
    ["period", "Period"],
    ["prodrome", "Early signs"],
    ["workout", "Exercise"],
    ["note", "Note"],
  ]);
});

test("the entry sheet is one dialog (plus the food item sheet and the AI notice), each with a named close button and one submit button", () => {
  assert.deepEqual([...html.matchAll(/<dialog\b[^>]*id="([^"]+)"/g)].map((m) => m[1]), ["sheet", "itemSheet", "aiNotice"]);
  assert.match(html, /<button[^>]*id="sheetClose"[^>]*aria-label="Close"/);
  assert.match(html, /<button[^>]*id="itemClose"[^>]*aria-label="Close"/);
  assert.equal([...html.matchAll(/type="submit"/g)].length, 2);   // entry sheet Save, item sheet Save
});

test("the tabs are Today, History and Insights, and the header buttons remain", () => {
  const tabs = [...html.matchAll(/<button[^>]*data-tab="[^"]+"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(tabs, ["Today", "History", "Insights"]);
  for (const id of ["settingsBtn", "changePasswordBtn", "signOutBtn", "printBtn"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
});

test("every chip and severity choice can be reached by keyboard", () => {
  assert.equal(/<(div|span)[^>]*class="(chip|sev-btn|tile|med-tap-btn)["\s]/.test(html), false);
});

test("header button labels stay visible on a phone, so no button is blank", () => {
  assert.equal(/\.btn-label\s*\{\s*display:\s*none/.test(base), false);
});

test("component styles use color tokens, never raw colors", () => {
  const values = [...components.matchAll(/:\s*([^;{}]+)[;}]/g)].map((m) => m[1]);
  for (const value of values) {
    assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(value), false, value);
  }
});

// ---------- Editing does not cost a new entry its draft ----------

function foodSheet(t, update = async () => {}) {
  const page = fakePage(t);
  const field = page.$("#foodText");
  page.list("#fields-food input, #fields-food textarea", [field]);
  initForms({ onEntrySaved() {}, onMedSaved() {} });
  setBackend({ update });
  openSheet("food");
  return { ...page, field };
}
const saved = { id: "e1", type: "food", time: "07:30", text: "eggs", split_status: "done" };

test("opening an edit, then closing it, gives the new draft back", (t) => {
  const { $, field } = foodSheet(t);
  field.value = "half a sandwich";
  openEditSheet(saved);
  assert.equal(field.value, "eggs");
  $("#sheet").close();
  openSheet("food");
  assert.equal(field.value, "half a sandwich");
});

test("saving an edit gives the new draft back", async (t) => {
  const updates = [];
  const { $, field } = foodSheet(t, async (id, date, entry) => { updates.push(entry.text); });
  field.value = "half a sandwich";
  openEditSheet(saved);
  field.value = "two eggs";
  $("#sheetForm").fire("submit", { preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(updates, ["two eggs"]);
  assert.equal(field.value, "half a sandwich");
});

test("a draft's time and chips come back too", (t) => {
  const { $, field, list } = foodSheet(t);
  const chip = new FakeElement();
  chip.classList.add("on");
  list("#fields-food .chip[data-val], #fields-food .sev-btn", [chip]);
  field.value = "half a sandwich";
  $("#entryTime").value = "12:15";
  openEditSheet(saved);
  assert.equal(chip.classList.contains("on"), false);
  assert.equal($("#entryTime").value, "07:30");
  openSheet("food");
  assert.equal(chip.classList.contains("on"), true);
  assert.equal($("#entryTime").value, "12:15");
  assert.equal(field.value, "half a sandwich");
});

test("a second edit in a row keeps the same draft, not the first edit", (t) => {
  const { field } = foodSheet(t);
  field.value = "half a sandwich";
  openEditSheet(saved);
  openEditSheet({ ...saved, id: "e2", text: "toast" });
  assert.equal(field.value, "toast");
  openSheet("food");
  assert.equal(field.value, "half a sandwich");
});

test("an edit left unsaved never leaks into the new draft", (t) => {
  const { field } = foodSheet(t);
  openEditSheet(saved);
  field.value = "changed my mind";
  openSheet("food");
  assert.equal(field.value, "");
});
