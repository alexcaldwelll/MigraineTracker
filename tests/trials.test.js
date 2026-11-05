import { test } from "node:test";
import assert from "node:assert/strict";
import { activeTrial, dueTrial, reviewTrial, startTrial, trialDay, trialLabel } from "../public/js/trials.js";
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

test("a trial that did not help is not suggested again, and a null result is safe", () => {
  const stats = buildStats([noteDay("2026-03-01")], { today: TODAY, medNames: [] });
  const worse = trial({ status: "completed", result: { before: 1, during: 2, summary: "" } });
  const unknown = trial({ status: "completed", result: { before: null, during: 1, summary: "" } });
  assert.doesNotThrow(() => ruleSuggestion(stats, [worse, unknown]));
});

test("labels come from the factor key", () => {
  assert.equal(trialLabel(trial()), "Sleep trial");
  assert.equal(trialLabel(trial({ suggestion: { ...NEXT, factor_key: null } })), "Your trial");
});
