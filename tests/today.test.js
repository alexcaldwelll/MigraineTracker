import { test } from "node:test";
import assert from "node:assert/strict";
import { setBackend } from "../public/js/data.js";
import { entryRowHtml, initToday, refreshHeadache, wireEntryRows } from "../public/js/today.js";
import { FakeElement, fakePage } from "./fake-page.js";

const failedFood = { id: "f1", type: "food", time: "08:00", text: "toast", split_status: "failed" };

test("a failed food entry offers Retry in History as well as on Today", () => {
  assert.match(entryRowHtml(failedFood, "2026-11-02"), /food-retry/);
  assert.match(entryRowHtml(failedFood, undefined, { editableItems: true }), /food-retry/);
  assert.doesNotMatch(entryRowHtml({ ...failedFood, split_status: "done" }, "2026-11-02"), /food-retry/);
});

test("Retry in History splits the entry on its own date", async (t) => {
  const { $ } = fakePage(t);
  const updates = [];
  setBackend({
    listDay: async () => [failedFood],
    listMeds: async () => [],
    update: async (id, date, entry) => { updates.push({ date, status: entry.split_status }); },
    getSettings: async () => ({ ai_notice_seen_at: "2026-11-01" }),
    ai: async () => ({ items: [] }),
  });
  const button = new FakeElement();
  button.dataset.id = "f1";
  const row = new FakeElement();
  row.dataset.date = "2026-11-02";
  button.parents[".entry-item"] = row;
  $("#historyList").found[".food-retry"] = [button];
  let historyDrawn = 0;
  initToday({ onEntryChanged: () => { historyDrawn++; } });
  wireEntryRows("#historyList", null);
  await button.click();
  assert.deepEqual(updates.map((u) => u.date), ["2026-11-02", "2026-11-02"]);
  assert.equal(updates.at(-1).status, "done");
  assert.equal(historyDrawn, 1);
});

// ---------- Delete takes two taps ----------

function deleteRow($) {
  const x = new FakeElement(), keep = new FakeElement(), error = new FakeElement(), row = new FakeElement();
  x.dataset.id = "e1";
  x.innerHTML = "<svg></svg>";
  x.setAttribute("aria-label", "Delete Food entry");
  keep.hidden = true;
  error.hidden = true;
  row.found = { ".entry-keep": keep, ".entry-error": error };
  x.parents[".entry-item"] = row;
  $("#todayList").found[".x"] = [x];
  wireEntryRows("#todayList", "2026-11-02");
  return { x, keep, error };
}

function deleteBackend(remove) {
  const backend = {
    removed: [],
    remove: async (id) => { await remove?.(); backend.removed.push(id); },
    listAll: async () => [], listDay: async () => [], listMeds: async () => [],
  };
  setBackend(backend);
  return backend;
}

test("a row carries the controls delete needs, hidden", () => {
  const html = entryRowHtml({ id: "e1", type: "note", time: "08:00", text: "x" }, "2026-11-02");
  assert.match(html, /class="link-btn entry-keep" hidden/);
  assert.match(html, /class="warn-box entry-error" role="alert" hidden/);
});

test("the first tap only arms delete, and the second deletes", async (t) => {
  const { $ } = fakePage(t);
  const backend = deleteBackend();
  const { x, keep } = deleteRow($);
  await x.click();
  assert.deepEqual(backend.removed, []);
  assert.equal(x.textContent, "Tap again to delete");
  assert.equal(keep.hidden, false);
  await x.click();
  assert.deepEqual(backend.removed, ["e1"]);
});

test("Keep disarms delete and puts the button back", async (t) => {
  const { $ } = fakePage(t);
  const backend = deleteBackend();
  const { x, keep } = deleteRow($);
  await x.click();
  keep.click();
  assert.equal(x.innerHTML, "<svg></svg>");
  assert.equal(x.getAttribute("aria-label"), "Delete Food entry");
  assert.equal(keep.hidden, true);
  await x.click();
  assert.deepEqual(backend.removed, []);
});

test("a failed delete shows inline with no alert, and a tap tries again", async (t) => {
  const { $ } = fakePage(t);
  t.mock.method(console, "error", () => {});
  globalThis.alert = () => assert.fail("alert was used");
  t.after(() => { delete globalThis.alert; });
  let down = true;
  const backend = deleteBackend(() => { if (down) throw new Error("offline"); });
  const { x, error } = deleteRow($);
  await x.click();
  await x.click();
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /offline/);
  assert.equal(x.disabled, false);
  down = false;
  await x.click();
  assert.deepEqual(backend.removed, ["e1"]);
  assert.equal(error.hidden, true);
});

// ---------- The headache button reads fresh days first ----------

const headacheRow = (over = {}) => ({ id: "h1", type: "headache", time: "22:00", open: true, start_at: "2026-11-01T22:00:00.000Z", ...over });

function headachePage(t, firstRows) {
  const page = fakePage(t);
  const backend = {
    rows: firstRows, added: [], updated: [], failReads: false,
    listAll: async () => {
      if (backend.failReads) throw new Error("offline");
      return [{ date: "2026-11-01", entries: backend.rows.map((r) => ({ ...r })) }];
    },
    listDay: async () => [], listMeds: async () => [], listTrials: async () => [],
    add: async (date, entry) => { backend.added.push(entry); return "new"; },
    update: async (id, date, entry) => { backend.updated.push({ id, entry }); },
  };
  setBackend(backend);
  initToday({ onEntryChanged() {} });
  return { ...page, backend };
}

test("ending a headache keeps details saved elsewhere since the last read", async (t) => {
  const { $, backend } = headachePage(t, [headacheRow()]);
  await refreshHeadache();
  backend.rows = [headacheRow({ severity: 7, note: "behind the eye" })];
  await $("#headacheBtn").click();
  assert.equal(backend.updated.length, 1);
  assert.equal(backend.updated[0].entry.open, false);
  assert.equal(backend.updated[0].entry.severity, 7);
  assert.equal(backend.updated[0].entry.note, "behind the eye");
});

test("a headache opened elsewhere since the last read is ended, not doubled", async (t) => {
  const { $, backend } = headachePage(t, []);
  await refreshHeadache();
  backend.rows = [headacheRow()];
  await $("#headacheBtn").click();
  assert.deepEqual(backend.added, []);
  assert.equal(backend.updated[0].id, "h1");
});

test("a headache ended elsewhere is not ended twice over newer details", async (t) => {
  const { $, backend } = headachePage(t, [headacheRow()]);
  await refreshHeadache();
  backend.rows = [headacheRow({ open: false, duration: 2, end_at: "2026-11-02T00:00:00.000Z" })];
  $("#headacheEndAt").value = "2026-11-02T03:00";
  await $("#headacheEndAtBtn").click();
  assert.deepEqual(backend.updated, []);
});

test("when the fresh read fails nothing is written, and Retry is offered", async (t) => {
  t.mock.method(console, "error", () => {});
  const { $, backend } = headachePage(t, [headacheRow()]);
  await refreshHeadache();
  backend.failReads = true;
  await $("#headacheBtn").click();
  assert.deepEqual(backend.updated, []);
  assert.equal($("#headacheError").hidden, false);
  assert.equal($("#headacheRetryBtn").hidden, false);
  backend.failReads = false;
  await $("#headacheRetryBtn").onclick();
  assert.equal(backend.updated.length, 1);
});
