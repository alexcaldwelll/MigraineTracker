import { test } from "node:test";
import assert from "node:assert/strict";
import { activeTrial, dueTrial, insightPredatesTrials, reviewTrial, startTrial, stopGate, trialDay, trialLabel } from "../public/js/trials.js";
import { setBackend } from "../public/js/data.js";
import { requestInsight, settleTrials, showSavedInsight, startFrom, stopTrial } from "../public/js/insights.js";
import { buildStats, ruleSuggestion } from "../public/js/patterns.js";
import { shiftDate } from "../public/js/dates.js";

const TODAY = "2026-03-20";
const NEXT = { title: "Get 7 or more hours of sleep", action: "Aim for it.", why: "Because.", confidence: "possible", days: 14, factor_key: "sleep:under_6", extra: "dropped" };
const headacheDay = (date) => ({ date, entries: [{ type: "headache", time: "10:00" }] });
const noteDay = (date) => ({ date, entries: [{ type: "note", time: "10:00", text: "x" }] });
const trial = (over = {}) => ({ id: "t1", suggestion: NEXT, start_date: "2026-03-15", end_date: "2026-03-28", status: "active", result: null, ...over });

test("trialDay is day 6 of 14 five days in, and caps after the end", () => {
  assert.deepEqual(trialDay(trial({ start_date: shiftDate(TODAY, -5), end_date: shiftDate(TODAY, 8) }), TODAY), { day: 6, total: 14 });
  assert.deepEqual(trialDay(trial(), "2026-05-01"), { day: 14, total: 14 });
  assert.deepEqual(trialDay(trial(), "2026-03-15"), { day: 1, total: 14 });
});

test("startTrial ends on start plus days minus one and stores the suggestion", () => {
  const t = startTrial(NEXT, "2026-03-15");
  assert.equal(t.start_date, "2026-03-15");
  assert.equal(t.end_date, "2026-03-28");
  assert.equal(t.status, "active");
  assert.equal(t.result, null);
  assert.deepEqual(t.suggestion, { title: NEXT.title, action: NEXT.action, why: NEXT.why, confidence: "possible", days: 14, factor_key: "sleep:under_6" });
});

test("a second trial while one is active returns null", () => {
  assert.equal(startTrial(NEXT, TODAY, [trial()]), null);
  assert.ok(startTrial(NEXT, TODAY, [trial({ status: "stopped" }), trial({ status: "completed" })]));
  assert.equal(activeTrial([trial({ status: "completed" })]), null);
});

test("dueTrial finds an active trial past its end date", () => {
  assert.equal(dueTrial([trial()], "2026-03-28"), null);
  assert.equal(dueTrial([trial()], "2026-03-29").id, "t1");
});

test("reviewTrial compares headache days per week over equal periods", () => {
  const days = [];
  for (let i = -14; i < 14; i++) days.push(noteDay(shiftDate("2026-03-15", i)));
  // 4 headache days before, 2 during.
  for (const i of [-14, -10, -6, -2]) days.push(headacheDay(shiftDate("2026-03-15", i)));
  for (const i of [1, 8]) days.push(headacheDay(shiftDate("2026-03-15", i)));
  const r = reviewTrial(trial(), days);
  assert.equal(r.before, 2);
  assert.equal(r.during, 1);
  assert.equal(r.beforeDays, 4);
  assert.equal(r.duringDays, 2);
  assert.match(r.summary, /fewer/);
  assert.match(r.summary, /can't prove cause/);
});

test("no data before the trial says there is nothing to compare against", () => {
  const days = [noteDay("2026-03-16"), headacheDay("2026-03-20")];
  const r = reviewTrial(trial(), days);
  assert.equal(r.before, null);
  assert.equal(r.during, 0.5);
  assert.match(r.summary, /nothing to compare against/);
  assert.match(r.summary, /can't prove cause/);
});

test("every summary says one trial can't prove cause", () => {
  const cases = [[], [noteDay("2026-03-01")], [noteDay("2026-03-16")], [noteDay("2026-03-01"), noteDay("2026-03-16")],
    [headacheDay("2026-03-01"), headacheDay("2026-03-16"), headacheDay("2026-03-17")]];
  for (const days of cases) assert.match(reviewTrial(trial(), days).summary, /can't prove cause/);
});

// 40 clean two-day spans, then five attacks 10 days apart, cheddar before three.
let nextId = 0;
const ent = (type, time, extra = {}) => ({ id: `e${nextId++}`, type, time, ...extra });
const cheddar = () => ent("food", "08:00", { text: "c", split_status: "done", items: [{ name: "cheddar", main_macro: "fat", food_type: "other", protein_g: 1, carbs_g: 1, fat_g: 1, tags: [] }] });
const rice = () => ent("food", "12:00", { text: "r", split_status: "done", items: [{ name: "rice", main_macro: "carbs", food_type: null, protein_g: 1, carbs_g: 1, fat_g: 1, tags: [] }] });
function cheddarStats() {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = n % 2 ? [ent("note", "09:00", { text: "x" })] : [rice()];
  for (const n of [0, 2, 4, 6, 8, 10]) log[n].push(cheddar());
  [81, 91, 101, 111, 121].forEach((n, i) => { log[n] = [ent("headache", "10:00")]; if (i < 3) log[n].push(cheddar()); });
  const days = Object.entries(log).map(([n, entries]) => ({ date: shiftDate("2026-01-01", Number(n)), entries }));
  return buildStats(days, { now: new Date("2026-05-20T12:00:00Z") });
}
const done = (result) => trial({ status: "completed", suggestion: { ...NEXT, title: "Skip cheddar", factor_key: "food:cheddar" }, result: { ...result, summary: "" } });

test("a food that did not help is not suggested again; a null before does not rule it out", () => {
  const stats = cheddarStats();
  assert.equal(ruleSuggestion(stats, []).try_next.factor_key, "food:cheddar");
  const worse = ruleSuggestion(stats, [done({ before: 1, during: 2 })]);
  assert.notEqual(worse.try_next.factor_key, "food:cheddar");
  const same = ruleSuggestion(stats, [done({ before: 1, during: 1 })]);
  assert.notEqual(same.try_next.factor_key, "food:cheddar");
  const better = ruleSuggestion(stats, [done({ before: 2, during: 1 })]);
  assert.equal(better.try_next.factor_key, "food:cheddar");
  const unknown = ruleSuggestion(stats, [done({ before: null, during: 1 })]);
  assert.equal(unknown.try_next.factor_key, "food:cheddar");
});

test("stopGate arms on the first tap, stops on the second, and cancel disarms", () => {
  const gate = stopGate();
  assert.equal(gate.press(), "arm");
  assert.equal(gate.press(), "stop");
  gate.cancel();
  assert.equal(gate.press(), "arm");
});

// ---------- Trial state in insights.js, against a fake backend ----------

function fakeBackend({ trials, failSave = false }) {
  const rows = trials.map((t) => ({ ...t }));
  const calls = { save: [], listTrials: 0 };
  setBackend({
    listTrials: async () => { calls.listTrials++; return rows.map((t) => ({ ...t })); },
    listAll: async () => [noteDay("2026-03-10"), headacheDay("2026-03-16")],
    saveTrial: async (t) => {
      calls.save.push(t);
      await new Promise((r) => setTimeout(r, 5));
      if (failSave) throw new Error("offline");
      return { ...t, id: t.id ?? "new-id" };
    },
  });
  return calls;
}
const quiet = (t) => t.mock.method(console, "error", () => {});

test("two concurrent settleTrials make one save per ended trial", async () => {
  const calls = fakeBackend({ trials: [trial()] });
  const [a, b] = await Promise.all([settleTrials("2026-03-29"), settleTrials("2026-03-29")]);
  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].status, "completed");
  assert.equal(typeof calls.save[0].result.summary, "string");
  assert.equal(a.trials[0].status, "completed");
  assert.equal(b.error, null);
});

test("a failed save returns the trials and the error, still active", async (t) => {
  quiet(t);
  fakeBackend({ trials: [trial()], failSave: true });
  const { trials, error } = await settleTrials("2026-03-29");
  assert.equal(error.message, "offline");
  assert.equal(trials[0].status, "active");
});

test("a trial is not settled on its end date, and is the day after", async () => {
  let calls = fakeBackend({ trials: [trial()] });
  const onEnd = await settleTrials("2026-03-28");
  assert.equal(calls.save.length, 0);
  assert.equal(onEnd.trials[0].status, "active");
  calls = fakeBackend({ trials: [trial()] });
  await settleTrials("2026-03-29");
  assert.equal(calls.save.length, 1);
});

test("starting while a trial runs creates nothing", async () => {
  const calls = fakeBackend({ trials: [trial()] });
  await assert.rejects(startFrom({ try_next: NEXT }), /already running/);
  assert.equal(calls.save.length, 0);
});

test("starting with none running saves one active trial", async () => {
  const calls = fakeBackend({ trials: [trial({ status: "stopped" })] });
  await startFrom({ try_next: NEXT });
  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].status, "active");
  assert.equal(calls.save[0].suggestion.factor_key, "sleep:under_6");
});

test("stopTrial saves stopped with no result, and a failure rejects so Retry can run again", async (t) => {
  quiet(t);
  let calls = fakeBackend({ trials: [trial()], failSave: true });
  await assert.rejects(stopTrial(trial()), /offline/);
  calls = fakeBackend({ trials: [trial()] });
  const saved = await stopTrial(trial());
  assert.equal(saved.status, "stopped");
  assert.equal(saved.result, null);
  assert.equal(calls.save.length, 1);
});

test("labels come from the factor key", () => {
  assert.equal(trialLabel(trial()), "Sleep trial");
  assert.equal(trialLabel(trial({ suggestion: { ...NEXT, factor_key: null } })), "Your trial");
});

// ---------- A failed trial is not offered again ----------

test("an insight older than the newest trial is out of date, however each date is written", () => {
  const saved = { created_at: "2026-03-10T09:00:00.000Z" };
  const later = { created_at: "2026-03-10T09:00:00.123456+00:00" };
  assert.equal(insightPredatesTrials(saved, [later]), true);
  assert.equal(insightPredatesTrials(saved, [{ created_at: "2026-03-10T10:00:00+01:00" }]), false);
  assert.equal(insightPredatesTrials({ created_at: "2026-03-11T00:00:00Z" }, [later]), false);
  assert.equal(insightPredatesTrials(saved, []), false);
});

function fakeInsightPage() {
  const doc = { createElement: () => ({ ownerDocument: doc, append() {}, addEventListener() {} }) };
  const page = { kids: null, ownerDocument: doc, replaceChildren(...kids) { page.kids = kids; } };
  return page;
}

test("a saved insight from before the newest trial is not shown, and an older screen is cleared", async () => {
  const page = fakeInsightPage();
  setBackend({ getInsight: async () => ({ created_at: "2026-03-01T00:00:00Z", result: { try_next: NEXT } }) });
  await showSavedInsight(page, [trial({ status: "completed", created_at: "2026-03-02T00:00:00Z" })]);
  assert.deepEqual(page.kids, []);
});

test("a saved insight from after the newest trial is shown", async () => {
  const page = fakeInsightPage();
  setBackend({ getInsight: async () => ({ created_at: "2026-03-03T00:00:00Z", result: { try_next: NEXT } }) });
  await showSavedInsight(page, [trial({ status: "completed", created_at: "2026-03-02T00:00:00Z" })]);
  assert.ok(page.kids.length > 0);
});

test("the browser's own fallback rules out a trial that did not help", async (t) => {
  quiet(t);
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = n % 2 ? [ent("note", "09:00", { text: "x" })] : [rice()];
  for (const n of [0, 2, 4, 6, 8, 10]) log[n].push(cheddar());
  [81, 91, 101, 111, 121].forEach((n, i) => { log[n] = [ent("headache", "10:00")]; if (i < 3) log[n].push(cheddar()); });
  const days = Object.entries(log).map(([n, entries]) => ({ date: shiftDate("2026-01-01", Number(n)), entries }));
  const backend = (trials) => ({
    ai: async () => { throw new Error("offline"); },
    listAll: async () => days,
    listMeds: async () => [],
    listTrials: async () => trials,
  });
  setBackend(backend([]));
  assert.equal((await requestInsight("2026-05-20")).try_next.factor_key, "food:cheddar");
  setBackend(backend([done({ before: 1, during: 2 })]));
  assert.notEqual((await requestInsight("2026-05-20")).try_next.factor_key, "food:cheddar");
});

test("the fallback still answers when the trials cannot be read", async (t) => {
  quiet(t);
  setBackend({
    ai: async () => { throw new Error("offline"); },
    listAll: async () => [],
    listMeds: async () => [],
    listTrials: async () => { throw new Error("offline"); },
  });
  assert.equal((await requestInsight("2026-05-20")).source, "rules");
});
