import { test } from "node:test";
import assert from "node:assert/strict";
import { setBackend } from "../public/js/data.js";
import { entryRowHtml, initToday, wireEntryRows } from "../public/js/today.js";
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
