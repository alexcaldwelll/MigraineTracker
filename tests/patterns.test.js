import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildStats, confidenceFor, ruleSuggestion } from "../public/js/patterns.js";
import { TAG_LABELS } from "../public/js/food-items.js";
import { FOOD_TYPES, TRIGGER_TAGS } from "../netlify/functions/lib/food.js";
import { shiftDate } from "../public/js/dates.js";

const BASE = "2026-01-01";
const date = (n) => shiftDate(BASE, n);
const nowAfter = (n) => new Date(`${date(n)}T12:00:00Z`);

let nextId = 0;
const item = (name, over = {}) => ({ name, main_macro: "fat", food_type: "other", protein_g: 1, carbs_g: 1, fat_g: 1, tags: [], ...over });
const food = (time, ...items) => ({ id: `e${nextId++}`, type: "food", time, text: "lunch", split_status: "done", items });
const headache = (time, over = {}) => ({ id: `e${nextId++}`, type: "headache", time, ...over });
const sleep = (hours, time = "07:00") => ({ id: `e${nextId++}`, type: "sleep", time, hours });
const note = () => ({ id: `e${nextId++}`, type: "note", time: "09:00", text: "fine" });
const rice = () => food("12:00", item("rice", { food_type: null })); // makes a control window count for food

// { 0: [entries], 3: [entries] } -> days, keyed by offset from BASE.
const daysOf = (log) => Object.entries(log).map(([n, entries]) => ({ date: date(Number(n)), entries }));
const factor = (stats, key) => stats.factors.find((f) => f.key === key);

// 40 clean two-day spans (days 0 to 79, food in each, cheddar in 6), then five
// attacks 10 days apart with nothing logged between, cheddar before the first three.
function fixture(foodName = "cheddar", over = {}) {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = n % 2 ? [note()] : [rice()];
  for (const n of [0, 2, 4, 6, 8, 10]) log[n].push(food("12:00", item(foodName, over)));
  [81, 91, 101, 111, 121].forEach((n, i) => {
    log[n] = [headache("10:00")];
    if (i < 3) log[n].push(food("08:00", item(foodName, over)));
  });
  return daysOf(log);
}

// `hits` of 8 attacks follow the food; `controlHits` of 40 controls contain it.
function statsWith(name, hits, controlHits, over = {}) {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = n % 2 ? [note()] : [rice()];
  for (let i = 0; i < controlHits; i++) log[i * 2].push(food("12:00", item(name, over)));
  for (let i = 0; i < 8; i++) {
    log[81 + i * 10] = [headache("10:00")];
    if (i < hits) log[81 + i * 10].push(food("08:00", item(name, over)));
  }
  return buildStats(daysOf(log), { now: nowAfter(170) });
}

test("a food in 3 of 5 lookbacks and 6 of 40 control windows reports those exact counts", () => {
  const stats = buildStats(fixture(), { now: nowAfter(140) });
  assert.equal(stats.attacks, 5);
  const f = factor(stats, "food:cheddar");
  assert.deepEqual(
    { before: f.beforeHeadache, total: f.headacheTotal, hits: f.controlHits, controls: f.controlTotal },
    { before: 3, total: 5, hits: 6, controls: 40 },
  );
  assert.equal(f.label, "Cheddar");
  assert.equal(f.confidence, "moderate");
});

test("two spellings in different entries count once when items share a lowercased name", () => {
  const stats = buildStats(daysOf({
    0: [food("08:00", item("Cheddar")), food("09:00", item("  cheddar "))],
    1: [headache("10:00")],
  }), { now: nowAfter(5) });
  const cheddars = stats.factors.filter((f) => f.key.startsWith("food:"));
  assert.equal(cheddars.length, 1);
  assert.equal(cheddars[0].key, "food:cheddar");
  assert.equal(cheddars[0].beforeHeadache, 1);
});

test("entries with time null are treated as 12:00 and do not throw", () => {
  const stats = buildStats(daysOf({
    0: [headache(null), food("11:00", item("before noon")), food("13:00", item("after noon")), food(null, item("same noon"))],
    2: [food(null, item("two days on"))],
    3: [headache(null)],
  }), { now: nowAfter(10) });
  assert.equal(factor(stats, "food:before noon").beforeHeadache, 1);
  assert.equal(factor(stats, "food:after noon"), undefined);
  assert.equal(factor(stats, "food:same noon"), undefined, "12:00 is at the start, so it is excluded");
  assert.equal(factor(stats, "food:two days on").beforeHeadache, 1);
});

test("an item logged at 23:50 is inside the window for a headache at 00:30 the next day", () => {
  const stats = buildStats(daysOf({
    0: [food("23:50", item("late snack"))],
    1: [headache("00:30")],
  }), { now: nowAfter(5) });
  assert.equal(factor(stats, "food:late snack").beforeHeadache, 1);
});

test("the lookback runs from 48 hours before the start, up to but not including it", () => {
  const stats = buildStats(daysOf({
    0: [food("09:59", item("too early")), food("10:00", item("exactly 48"))],
    2: [food("09:59", item("just before")), headache("10:00"), food("10:00", item("at start")), food("10:01", item("after"))],
  }), { now: nowAfter(5) });
  assert.deepEqual(stats.factors.filter((f) => f.key.startsWith("food:")).map((f) => f.key).sort(), ["food:exactly 48", "food:just before"]);
});

test("an attack starts at its stored date and time, not at start_at", () => {
  const elsewhere = new Date(`${date(5)}T09:00:00Z`).toISOString();
  const stats = buildStats(daysOf({
    0: [food("12:00", item("after")), headache("10:00", { start_at: elsewhere })],
    4: [food("12:00", item("near start_at"))],
  }), { now: nowAfter(9) });
  assert.deepEqual(stats.factors, []);
  assert.equal(stats.attacks, 1);
});

test("an invalid time counts as 12:00 and does not throw", () => {
  const stats = buildStats(daysOf({ 0: [food("99:99", item("bad time")), headache("25:00")] }), { now: nowAfter(5) });
  assert.equal(stats.attacks, 1);
  assert.equal(factor(stats, "food:bad time"), undefined, "both land on 12:00");
  const next = buildStats(daysOf({ 0: [food("99:99", item("bad time"))], 1: [headache("9:30")] }), { now: nowAfter(5) });
  assert.equal(factor(next, "food:bad time").beforeHeadache, 1, "9:30 parses");
});

test("attacks within 48 hours of a counted attack share its lookback, so one meal counts once", () => {
  const stats = buildStats(daysOf({
    0: [food("08:00", item("one meal"))],
    1: [headache("07:00"), headache("20:00")],
    3: [headache("06:59"), headache("07:00")],
  }), { now: nowAfter(9) });
  assert.equal(stats.attacks, 4);
  const f = factor(stats, "food:one meal");
  assert.equal(f.beforeHeadache, 1, "the attack exactly 48 hours on is new, and the meal is outside it");
  assert.equal(f.headacheTotal, 2);
});
test("one attack across midnight is one attack on two headache days, with or without entries that day", () => {
  const start = new Date(`${date(1)}T22:00:00`);
  const end = new Date(`${date(2)}T02:00:00`);
  const stats = buildStats(daysOf({
    0: [note()],
    1: [headache("22:00", { start_at: start.toISOString(), end_at: end.toISOString() })],
  }), { now: nowAfter(5) });
  assert.equal(stats.attacks, 1);
  assert.equal(stats.headacheDays, 2);
  assert.equal(stats.loggedDays, 2);
});

test("a factor seen in only one lookback is at most early guess", () => {
  assert.equal(confidenceFor(1, 1), "early guess");
  assert.equal(confidenceFor(1, 2, { hits: 0, total: 100 }), "early guess");
  const stats = buildStats(daysOf({ 0: [food("12:00", item("once"))], 1: [headache("10:00")] }), { now: nowAfter(5) });
  assert.equal(factor(stats, "food:once").confidence, "early guess");
});

test("confidenceFor rests on a Fisher test, corrected for how many factors were tested", () => {
  assert.equal(confidenceFor(5, 8), "early guess", "no control counts, nothing to compare");
  assert.equal(confidenceFor(5, 8, { hits: 3, total: 10 }), "early guess", "p is about 0.34");
  assert.equal(confidenceFor(3, 5, { hits: 0, total: 1 }), "early guess", "too few control windows");
  assert.equal(confidenceFor(5, 8, { hits: 0, total: 9 }), "early guess", "too few control windows");
  assert.equal(confidenceFor(2, 2, { hits: 0, total: 100 }), "early guess", "too few lookbacks");
  assert.equal(confidenceFor(3, 5, { hits: 6, total: 40 }), "moderate");
  assert.equal(confidenceFor(4, 4, { hits: 0, total: 40 }), "moderate", "under 5 lookbacks is never strong");
  assert.equal(confidenceFor(6, 8, { hits: 2, total: 40 }), "strong");
  assert.equal(confidenceFor(6, 8, { hits: 2, total: 40 }, { tested: 305, cutoff: 0.001 }), "strong");
  assert.equal(confidenceFor(6, 8, { hits: 2, total: 40 }, { tested: 2000, cutoff: 0.001 }), "moderate", "fails Bonferroni, passes the cutoff");
  assert.equal(confidenceFor(6, 8, { hits: 2, total: 40 }, { tested: 2000, cutoff: -1 }), "early guess", "fails both");
  assert.equal(confidenceFor(5, 8, { hits: 24, total: 40 }), "early guess", "no real difference");
});
test("confidenceFor can test separate hits while the plain counts stand", () => {
  const control = { hits: 2, total: 40 };
  assert.equal(confidenceFor(6, 8, control, { separate: { hits: 2, total: 2 } }), "early guess", "under 3 separate hits");
  assert.equal(confidenceFor(6, 8, control, { separate: { hits: 3, total: 3 } }), "moderate");
  assert.equal(confidenceFor(6, 8, control, { separate: { hits: 4, total: 8 } }), "moderate");
  assert.equal(confidenceFor(6, 8, control, { separate: { hits: 5, total: 8 } }), "strong");
});

test("one eating streak before several attacks is one hit for confidence, with plain counts kept", () => {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = n % 2 ? [note()] : [rice()];
  for (let i = 0; i < 6; i++) { log[81 + i * 2] = [headache("10:00")]; log[80 + i * 2] = [food("20:00", item("streak"))]; }
  const f = factor(buildStats(daysOf(log), { now: nowAfter(120) }), "food:streak");
  assert.deepEqual([f.beforeHeadache, f.headacheTotal, f.controlHits, f.controlTotal], [6, 6, 0, 40]);
  assert.equal(f.confidence, "early guess");
});

test("exposures with gaps of up to 2 days are one episode, and 3 days are two", () => {
  // Attacks are 8 days apart, so separate clusters. Food on the attack days, plus
  // on `steps` days after each. A step of 3 leaves 2 empty days, a step of 4 leaves 3.
  const confidence = (steps) => {
    const log = {};
    for (let n = 0; n < 80; n++) log[n] = n % 2 ? [note()] : [rice()];
    for (let i = 0; i < 5; i++) {
      log[81 + i * 8] = [headache("10:00"), food("08:00", item("snack"))];
      if (i < 4) for (const step of steps) log[81 + i * 8 + step] = [food("08:00", item("snack"))];
    }
    return factor(buildStats(daysOf(log), { now: nowAfter(170) }), "food:snack").confidence;
  };
  assert.equal(confidence([]), "strong", "5 episodes");
  assert.equal(confidence([4]), "strong", "gaps of 3 days keep them apart");
  assert.equal(confidence([3, 6]), "early guess", "gaps of 2 days bridge them into 1 episode");
});

test("attacks under 7 days apart are one cluster, and 7 days apart are two", () => {
  const confidence = (gap) => {
    const log = {};
    for (let n = 0; n < 80; n++) log[n] = n % 2 ? [note()] : [rice()];
    for (let i = 0; i < 5; i++) log[81 + i * gap] = [headache("10:00"), food("08:00", item("snack"))];
    return factor(buildStats(daysOf(log), { now: nowAfter(170) }), "food:snack").confidence;
  };
  assert.equal(confidence(7), "strong");
  assert.equal(confidence(6), "early guess");
});

test("buildStats gives a repeated factor with a clear gap a strong rating", () => {
  assert.equal(factor(statsWith("red wine", 6, 2), "food:red wine").confidence, "strong");
  assert.equal(factor(statsWith("toast", 6, 28), "food:toast").confidence, "early guess");
});

test("removed items do not count, and entries with no items count only in gaps", () => {
  const stats = buildStats(daysOf({
    0: [
      food("12:00", item("kept"), item("deleted", { removed: true, edited: true })),
      { id: "old", type: "food", time: "13:00", text: "toast" },
      { id: "failed", type: "food", time: "14:00", text: "soup", split_status: "failed" },
      { id: "wait", type: "food", time: "15:00", text: "rice", split_status: "pending", items: [item("stale")] },
      { id: "empty", type: "food", time: "16:00", text: "?", split_status: "done", items: [] },
    ],
    1: [headache("10:00")],
  }), { now: nowAfter(5) });
  const foods = stats.factors.filter((f) => f.key.startsWith("food:")).map((f) => f.key);
  assert.deepEqual(foods, ["food:kept"]);
  assert.equal(stats.gaps.unsplitFoodEntries, 3);
});

test("food_type and tags are factors, and main_macro never is", () => {
  const stats = buildStats(daysOf({
    0: [food("12:00", item("cheddar", { main_macro: "fat", food_type: "dairy", tags: ["aged_cheese", "made_up"] }), item("fat", { food_type: "protein" }), item("Carbs"))],
    1: [headache("10:00")],
  }), { now: nowAfter(5) });
  const keys = stats.factors.map((f) => f.key).sort();
  assert.deepEqual(keys, ["food:cheddar", "tag:aged_cheese", "type:dairy", "type:other"]);
  assert.equal(factor(stats, "type:dairy").label, "Dairy");
  assert.equal(factor(stats, "tag:aged_cheese").label, "Aged cheese");
});

test("sleep falls into bands under 6, 6 to 7 and 7+, and a day's sleep is added up", () => {
  const band = (...hours) => {
    const stats = buildStats(daysOf({ 0: hours.map((h) => sleep(h)), 1: [headache("10:00")] }), { now: nowAfter(5) });
    return stats.factors.filter((f) => f.key.startsWith("sleep:")).map((f) => f.key);
  };
  assert.deepEqual(band(5.9), ["sleep:under_6"]);
  assert.deepEqual(band(6), ["sleep:6_to_7"]);
  assert.deepEqual(band(6.9), ["sleep:6_to_7"]);
  assert.deepEqual(band(7), ["sleep:7_plus"]);
  assert.deepEqual(band(5.5, 1.5), ["sleep:7_plus"], "a nap joins the night");
  assert.deepEqual(band(null), [], "no hours, no band");
});

test("control windows skip headache days, unlogged stretches and days not yet over", () => {
  const stats = buildStats(daysOf({
    0: [sleep(8)], 1: [sleep(8)],               // a span
    2: [sleep(5)], 3: [headache("10:00")],      // day 2 cannot pair with a headache day
    4: [sleep(8)], 5: [sleep(8)],               // a span
    // 6 to 19 were never logged
    20: [sleep(8)],                             // today, so it cannot join day 19
  }), { now: nowAfter(20) });
  assert.equal(factor(stats, "sleep:under_6").controlTotal, 2);
  assert.equal(factor(stats, "sleep:under_6").controlHits, 0);
});

test("a control window counts for food only with split food, and for sleep only with hours", () => {
  const log = {};
  for (let n = 0; n < 80; n += 2) log[n] = [note()];
  log[0] = [sleep(8)];
  log[2] = [{ id: "old", type: "food", time: "12:00", text: "toast" }];
  log[4] = [food("12:00", item("rice"))];
  log[6] = [food("12:00", item("toast"))];
  for (let i = 0; i < 6; i++) { log[81 + i * 2] = [headache("10:00")]; log[80 + i * 2] = [sleep(5), food("20:00", item("toast"))]; }
  const stats = buildStats(daysOf(log), { now: nowAfter(120) });
  const toast = factor(stats, "food:toast");
  assert.deepEqual([toast.beforeHeadache, toast.headacheTotal, toast.controlHits, toast.controlTotal], [6, 6, 1, 2]);
  const short = factor(stats, "sleep:under_6");
  assert.deepEqual([short.beforeHeadache, short.controlHits, short.controlTotal], [6, 0, 1]);
});

test("food logged only around headaches is no evidence", () => {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = [{ id: "m", type: "meds", time: "08:00", name: "prop", category: "preventive" }];
  for (let i = 0; i < 6; i++) { log[81 + i * 2] = [headache("10:00")]; log[80 + i * 2] = [food("20:00", item("toast"))]; }
  const stats = buildStats(daysOf(log), { now: nowAfter(120) });
  const f = factor(stats, "food:toast");
  assert.deepEqual([f.beforeHeadache, f.controlTotal, f.confidence], [6, 0, "early guess"]);
  const { try_next } = ruleSuggestion(stats, []);
  assert.equal(try_next.factor_key, null);
  assert.match(try_next.title, /log/i);
});
test("a log with no headache-free span stays an early guess and asks for logging", () => {
  const log = {};
  for (let i = 0; i < 6; i++) log[i * 2] = [headache("10:00")];
  for (let i = 0; i < 5; i++) log[i * 2 + 1] = [sleep(8), food("12:00", item("coffee"))];
  const stats = buildStats(daysOf(log), { now: nowAfter(11) });
  const f = factor(stats, "food:coffee");
  assert.equal(f.controlTotal, 0);
  assert.equal(f.beforeHeadache, 5);
  assert.equal(f.confidence, "early guess");
  const { try_next } = ruleSuggestion(stats, []);
  assert.equal(try_next.factor_key, null);
  assert.doesNotMatch(try_next.title, /coffee/i);
});

test("with full logging but no headache-free stretch, the suggestion is more logging, not a habit", () => {
  const log = {};
  for (let i = 0; i < 6; i++) log[i * 2] = [sleep(8), food("08:00", item("coffee")), headache("10:00")];
  for (let i = 0; i < 6; i++) log[i * 2 + 1] = [sleep(8), food("12:00", item("coffee"))];
  const { try_next } = ruleSuggestion(buildStats(daysOf(log), { now: nowAfter(11) }), []);
  assert.equal(try_next.factor_key, null);
  assert.match(try_next.title, /keep logging/i);
  assert.match(try_next.why, /no headache-free/i);
});

test("cycle reports headache days by cycle day, and is null with no period data", () => {
  const period = () => ({ id: "p", type: "period", time: "08:00" });
  const stats = buildStats(daysOf({ 10: [period()], 8: [headache("10:00")], 11: [headache("10:00")], 60: [headache("10:00")] }), { now: nowAfter(70) });
  assert.deepEqual(stats.cycle, { periodStarts: 1, byCycleDay: { "-2": 1, "+1": 1 }, counted: 2, nearPeriod: 2 });
  assert.equal(buildStats(daysOf({ 8: [headache("10:00")] }), { now: nowAfter(70) }).cycle, null);
});

test("acuteMedDays30 counts days, not doses, in the last 30 days", () => {
  const acute = () => ({ id: "m", type: "meds", time: "09:00", name: "x", category: "acute" });
  const preventive = () => ({ id: "m", type: "meds", time: "09:00", name: "y", category: "preventive" });
  const stats = buildStats(daysOf({
    70: [acute()],               // 30 days ago: outside
    71: [acute(), acute()],      // 29 days ago: inside, one day
    80: [preventive()],
    100: [acute()],
  }), { now: nowAfter(100) });
  assert.equal(stats.acuteMedDays30, 2);
});

test("gaps counts logged days missing sleep and food", () => {
  const stats = buildStats(daysOf({
    0: [sleep(8), food("12:00", item("x"))],
    1: [sleep(null), note()],
    2: [{ id: "old", type: "food", time: "12:00", text: "toast" }],
  }), { now: nowAfter(5) });
  assert.deepEqual(stats.gaps, { missingSleepDays: 2, missingFoodDays: 1, unsplitFoodEntries: 1 });
});

const assertValid = (result) => {
  const t = result.try_next;
  assert.ok(t.title && t.action && t.why, "try_next is filled in");
  assert.ok(["early guess", "moderate", "strong"].includes(t.confidence));
  assert.ok(Number.isInteger(t.days) && t.days >= 14 && t.days <= 28);
  assert.ok("factor_key" in t);
  assert.ok(Array.isArray(result.also_watching));
  assert.equal(typeof result.keep_logging, "string");
  assert.ok(result.keep_logging.length > 0);
  assert.ok(Array.isArray(result.doctor_questions));
  assert.ok("cycle_note" in result);
  assert.ok("medication_note" in result);
};

test("zero days gives a valid result that says what to log and for how long", () => {
  const stats = buildStats([], { now: nowAfter(0) });
  assert.deepEqual(
    { attacks: stats.attacks, headacheDays: stats.headacheDays, loggedDays: stats.loggedDays, factors: stats.factors, cycle: stats.cycle, acute: stats.acuteMedDays30 },
    { attacks: 0, headacheDays: 0, loggedDays: 0, factors: [], cycle: null, acute: 0 },
  );
  const result = ruleSuggestion(stats, []);
  assertValid(result);
  assert.match(result.try_next.title, /log/i);
  assert.match(result.try_next.title, /sleep/i);
  assert.match(result.try_next.action, /2 weeks/);
  assert.equal(result.try_next.days, 14);
  assert.equal(result.try_next.factor_key, null);
});

test("zero headaches gives a valid keep-logging suggestion", () => {
  const stats = buildStats(daysOf({ 0: [sleep(8)], 1: [food("12:00", item("toast"))] }), { now: nowAfter(5) });
  const result = ruleSuggestion(stats, []);
  assertValid(result);
  assert.match(result.try_next.title, /keep logging/i);
  assert.match(result.try_next.why, /no headaches/i);
});

test("one headache with no food logged gives a valid suggestion to log food", () => {
  const stats = buildStats(daysOf({ 0: [sleep(8)], 1: [sleep(8), headache("10:00")] }), { now: nowAfter(5) });
  const result = ruleSuggestion(stats, []);
  assertValid(result);
  assert.match(result.try_next.title, /food/i);
  assert.equal(result.try_next.factor_key, null);
});

test("ruleSuggestion turns the best factor into a trial, with counts in the why", () => {
  const result = ruleSuggestion(buildStats(fixture(), { now: nowAfter(140) }), []);
  assertValid(result);
  assert.equal(result.try_next.factor_key, "food:cheddar");
  assert.match(result.try_next.title, /cheddar/);
  assert.match(result.try_next.why, /3 of 5/);
  assert.match(result.try_next.why, /6 of 40/);
  assert.equal(result.try_next.confidence, "moderate");
});

test("a single lookback is not enough to name a food", () => {
  const result = ruleSuggestion(buildStats(daysOf({
    0: [sleep(8), food("12:00", item("toast"))], 1: [sleep(8), headache("10:00")],
  }), { now: nowAfter(5) }), []);
  assert.equal(result.try_next.factor_key, null);
  assert.deepEqual(result.also_watching, []);
});

test("a factor less common before headaches than in controls is not suggested", () => {
  const stats = statsWith("toast", 3, 36);
  assert.ok(factor(stats, "food:toast"));
  const result = ruleSuggestion(stats, []);
  assert.notEqual(result.try_next.factor_key, "food:toast");
  assert.ok(!result.also_watching.some((w) => /toast/i.test(w.item)));
});

test("sleep suggestions run 14 days, food ones 14 to 28, and each counts its weeks", () => {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = [sleep(8)];
  for (let i = 0; i < 6; i++) { log[81 + i * 2] = [headache("10:00")]; log[80 + i * 2] = [sleep(5)]; }
  const result = ruleSuggestion(buildStats(daysOf(log), { now: nowAfter(120) }), []);
  assert.equal(result.try_next.factor_key, "sleep:under_6");
  assert.equal(result.try_next.title, "Aim for 7+ hours of sleep");
  assert.equal(result.try_next.days, 14);
  assert.match(result.try_next.action, /2 weeks/);
  for (const [name, over, key] of [
    ["wine", {}, "food:wine"],
    ["x", { tags: ["alcohol"] }, "tag:alcohol"],
    ["y", { food_type: "dairy" }, "type:dairy"],
  ]) {
    const stats = statsWith(name, 6, 2, over);
    stats.factors = stats.factors.filter((f) => !f.key.startsWith("food:") || key.startsWith("food:"));
    const t = ruleSuggestion(stats, []).try_next;
    assert.equal(t.factor_key, key);
    assert.ok(t.days >= 14 && t.days <= 28);
    assert.match(t.action, new RegExp(`${t.days / 7} weeks`));
  }
});

test("when a food and its group tie, the specific food is suggested first", () => {
  const stats = statsWith("cheddar", 6, 2, { food_type: "dairy", tags: ["aged_cheese"] });
  assert.equal(ruleSuggestion(stats, []).try_next.factor_key, "food:cheddar");
});

const failedTrial = (factor_key, title = "x") => ({ suggestion: { factor_key, title }, status: "completed", result: { before: 2, during: 2 } });

test("ruleSuggestion never repeats a factor from a completed trial with no improvement", () => {
  const stats = statsWith("cheddar", 6, 2, { food_type: "dairy", tags: ["aged_cheese"] });
  const worse = { suggestion: { factor_key: "food:cheddar", title: "x" }, status: "completed", result: { before: 2, during: 3 } };
  for (const trial of [failedTrial("food:cheddar"), worse]) {
    const result = ruleSuggestion(stats, [trial]);
    assertValid(result);
    assert.notEqual(result.try_next.factor_key, "food:cheddar");
    assert.ok(!result.also_watching.some((w) => w.item === "Cheddar"));
  }
});

test("a trial with no factor_key is matched by its title", () => {
  const stats = statsWith("cheddar", 6, 2);
  const { title } = ruleSuggestion(stats, []).try_next;
  const result = ruleSuggestion(stats, [{ suggestion: { title: title.toUpperCase() }, status: "completed", result: { before: 1, during: 1 } }]);
  assert.notEqual(result.try_next.title, title);
});

test("trials that helped, were stopped, or have no result may be suggested again", () => {
  const stats = statsWith("cheddar", 6, 2);
  const suggestion = { factor_key: "food:cheddar", title: "x" };
  for (const trial of [
    { suggestion, status: "completed", result: { before: 3, during: 1 } },
    { suggestion, status: "stopped", result: { before: 1, during: 1 } },
    { suggestion, status: "completed", result: null },
  ]) {
    assert.equal(ruleSuggestion(stats, [trial]).try_next.factor_key, "food:cheddar");
  }
});

test("the two short-sleep bands share a suggestion, so a failed one blocks both", () => {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = [sleep(8)];
  for (let i = 0; i < 6; i++) { log[81 + i * 2] = [headache("10:00")]; log[80 + i * 2] = [sleep(5), food("12:00", item("toast"))]; }
  log[80] = [sleep(6.5)]; log[82] = [sleep(6.5)]; log[84] = [sleep(6.5)];
  const stats = buildStats(daysOf(log), { now: nowAfter(120) });
  assert.ok(stats.factors.filter((f) => /sleep:(under_6|6_to_7)/.test(f.key)).length === 2);
  const result = ruleSuggestion(stats, [failedTrial("sleep:under_6", "Aim for 7+ hours of sleep")]);
  assert.ok(!/^sleep:/.test(result.try_next.factor_key || ""));
  assert.equal(new Set(result.also_watching.map((w) => w.item)).size, result.also_watching.length);
  assert.ok(!result.also_watching.some((w) => /sleep/i.test(w.item)));
});

test("with every option tried, ruleSuggestion still returns something to do", () => {
  const stats = statsWith("cheddar", 6, 2, { food_type: "dairy", tags: ["aged_cheese"] });
  const tried = [];
  for (let i = 0; i < 12; i++) {
    const { factor_key, title } = ruleSuggestion(stats, tried).try_next;
    if (!factor_key) break;
    assert.ok(!tried.some((t) => t.suggestion.factor_key === factor_key), "no repeats");
    tried.push(failedTrial(factor_key, title));
  }
  const result = ruleSuggestion(stats, tried);
  assertValid(result);
  assert.equal(result.try_next.factor_key, null);
});

test("ruleSuggestion never targets a main_macro value", () => {
  const stats = statsWith("butter", 6, 2, { main_macro: "fat" });
  const macros = /\b(protein|carbs?|carbohydrates?|fats?)\b/i;
  const tried = [];
  for (let i = 0; i < 8; i++) {
    const result = ruleSuggestion(stats, tried);
    assert.doesNotMatch(result.try_next.title, macros);
    assert.doesNotMatch(result.try_next.action, macros);
    assert.ok(!result.also_watching.some((w) => macros.test(w.item)));
    if (!result.try_next.factor_key) break;
    tried.push(failedTrial(result.try_next.factor_key, result.try_next.title));
  }
  assert.ok(!stats.factors.some((f) => macros.test(f.key)));
});

test("only dairy and sweets are suggestible groups, and a broad top signal goes to the doctor", () => {
  for (const food_type of ["meat_fish", "grains", "fruit_veg", "legumes_nuts", "drinks", "other"]) {
    const stats = statsWith("mystery", 6, 2, { food_type });
    assert.ok(factor(stats, `type:${food_type}`));
    stats.factors = stats.factors.filter((f) => !f.key.startsWith("food:"));
    const result = ruleSuggestion(stats, []);
    assertValid(result);
    assert.ok(!(result.try_next.factor_key || "").startsWith("type:"), food_type);
    assert.ok(!result.also_watching.some((w) => w.item === stats.factors[0].label));
    assert.ok(result.doctor_questions.some((q) => q.startsWith(stats.factors[0].label)), food_type);
  }
  for (const [food_type, key] of [["dairy", "type:dairy"], ["sweets_snacks", "type:sweets_snacks"]]) {
    const stats = statsWith("mystery", 6, 2, { food_type });
    stats.factors = stats.factors.filter((f) => !f.key.startsWith("food:"));
    assert.equal(ruleSuggestion(stats, []).try_next.factor_key, key);
  }
});

test("an individual food in a broad group stays suggestible", () => {
  const result = ruleSuggestion(statsWith("red wine", 6, 2, { food_type: "drinks" }), []);
  assert.equal(result.try_next.factor_key, "food:red wine");
  assert.ok(!result.doctor_questions.some((q) => q.startsWith("Drinks")), "the food outranks its group");
});

test("a broad group that is only an early guess stays away from the doctor", () => {
  const stats = statsWith("mystery", 3, 4, { food_type: "grains" });
  stats.factors = stats.factors.filter((f) => f.key === "type:grains").map((f) => ({ ...f, confidence: "early guess" }));
  assert.deepEqual(ruleSuggestion(stats, []).doctor_questions.filter((q) => q.startsWith("Grains")), []);
});

test("water and medicines are never food factors", () => {
  const meds = { id: "m", type: "meds", time: "08:00", name: " Rizatriptan ", category: "acute" };
  const stats = buildStats(daysOf({
    0: [meds, food("12:00", item("Water"), item("sparkling water"), item("watermelon"), item("rizatriptan"), item("Ibuprofen 400mg"), item("advil"), item("Mystery pill"))],
    1: [headache("10:00")],
  }), { now: nowAfter(5), medNames: ["mystery pill"] });
  assert.deepEqual(stats.factors.filter((f) => f.key.startsWith("food:")).map((f) => f.key), ["food:watermelon"]);
});

test("medicine names match through doses, punctuation and plurals, both ways round", () => {
  const foods = (names, logged = [], options = {}) => {
    const stats = buildStats(daysOf({
      0: [...logged.map((name) => ({ id: "m", type: "meds", time: "08:00", name, category: "acute" })), food("12:00", ...names.map((n) => item(n)))],
      1: [headache("10:00")],
    }), { now: nowAfter(5), ...options });
    return stats.factors.filter((f) => f.key.startsWith("food:")).map((f) => f.key);
  };
  assert.deepEqual(foods(["ibuprofen, 400mg", "ibuprofen-200", "advils", "two aspirins", "Tylenol 500 mg tablets"]), []);
  assert.deepEqual(foods(["rizatriptan"], ["Rizatriptan 10mg"]), []);
  assert.deepEqual(foods(["zolmig"], ["Zolmig Rapimelt"]), [], "the food is part of the med's name");
  assert.deepEqual(foods(["propranolols, 40 mg"], ["Propranolol"]), []);
  assert.deepEqual(foods(["propranolol tablets"], ["Propranolol 40mg"]), [], "doses and forms do not count as name words");
  assert.deepEqual(foods(["half a pink pill"], [], { medNames: ["Pink pill"] }), [], "every word of the med appears");
  assert.deepEqual(foods(["eletriptan", "frovatriptans 2.5mg"]), [], "any triptan, listed or not");
  assert.deepEqual(foods(["bread", "pasta"], ["Zolmig Rapimelt"]), ["food:bread", "food:pasta"]);
});

test("caffeine wording also goes by name, for items with no tag", () => {
  for (const name of ["coffee", "Iced latte", "espresso", "caffeine", "cold brew", "energy drink", "black tea", "matcha", "cola", "cappuccinos"]) {
    const stats = statsWith(name, 6, 2);
    const { try_next } = ruleSuggestion(stats, []);
    assert.equal(try_next.factor_key, `food:${name.toLowerCase()}`);
    assert.doesNotMatch(try_next.title, /skip/i, name);
    assert.match(try_next.action, /gradually over a week or so/, name);
  }
  assert.match(ruleSuggestion(statsWith("cheese", 6, 2), []).try_next.title, /^Skip/);
  assert.match(ruleSuggestion(statsWith("steak", 6, 2), []).try_next.title, /^Skip/, "tea inside a word does not count");
});

test("caffeine suggestions say to ease down gradually", () => {
  const stats = statsWith("coffee", 6, 2, { tags: ["caffeine"] });
  const food = ruleSuggestion(stats, []);
  assert.equal(food.try_next.factor_key, "food:coffee");
  stats.factors = stats.factors.filter((f) => !f.key.startsWith("food:"));
  const tag = ruleSuggestion(stats, []);
  assert.equal(tag.try_next.factor_key, "tag:caffeine");
  for (const { try_next } of [food, tag]) {
    assert.doesNotMatch(try_next.title, /skip/i);
    assert.match(try_next.action, /gradually over a week or so/);
    assert.match(try_next.action, /suddenly can trigger headaches/);
    assert.equal(try_next.days, 21);
  }
});
test("7+ hours of sleep is reported but never suggested as something to change", () => {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = [sleep(5)];
  for (let i = 0; i < 6; i++) { log[81 + i * 2] = [headache("10:00")]; log[80 + i * 2] = [sleep(8)]; }
  const stats = buildStats(daysOf(log), { now: nowAfter(120) });
  assert.ok(factor(stats, "sleep:7_plus").beforeHeadache >= 5);
  assert.notEqual(ruleSuggestion(stats, []).try_next.factor_key, "sleep:7_plus");
});

test("no clear factor after several headaches gives a low-risk habit to try", () => {
  const log = {};
  for (let i = 0; i < 6; i++) { log[i * 3] = [sleep(8), food("12:00", item("toast"))]; log[i * 3 + 1] = [sleep(8), food("12:00", item("toast")), headache("18:00")]; log[i * 3 + 2] = [sleep(8), food("12:00", item("toast"))]; }
  for (let n = 30; n < 60; n++) log[n] = [sleep(8), food("12:00", item("toast"))];
  const result = ruleSuggestion(buildStats(daysOf(log), { now: nowAfter(70) }), []);
  assertValid(result);
  assert.match(result.try_next.factor_key, /^habit:/);
});

test("eight or more acute days is a doctor question, and never advice about medication", () => {
  const log = {};
  for (let n = 0; n < 9; n++) log[n] = [{ id: "m", type: "meds", time: "09:00", name: "x", category: "acute" }];
  const result = ruleSuggestion(buildStats(daysOf(log), { now: nowAfter(9) }), []);
  assert.match(result.medication_note, /doctor/i);
  assert.match(result.medication_note, /9 of the last 30 days/);
  assert.ok(result.doctor_questions.some((q) => /medication/i.test(q)));
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /\b(stop|start|change|switch|reduce|increase|cut|take|taking)\b[^"]*\bmedication/i);
  assert.equal(ruleSuggestion(buildStats([], { now: nowAfter(9) }), []).medication_note, null);
});

test("headache days clustering near a period give a cycle note and a doctor question", () => {
  const period = () => ({ id: "p", type: "period", time: "08:00" });
  const stats = buildStats(daysOf({
    10: [period()], 9: [headache("10:00")], 11: [headache("10:00")],
    40: [period()], 41: [headache("10:00")], 25: [headache("10:00")],
  }), { now: nowAfter(70) });
  const result = ruleSuggestion(stats, []);
  assert.match(result.cycle_note, /3 of 4/);
  assert.ok(result.doctor_questions.some((q) => /cycle/i.test(q)));
  assert.equal(ruleSuggestion(buildStats(daysOf({ 25: [period()], 2: [headache("10:00")] }), { now: nowAfter(70) }), []).cycle_note, null);
});

test("keep_logging names the biggest gap, including unsplit old entries", () => {
  const stats = { attacks: 0, headacheDays: 0, loggedDays: 20, factors: [], cycle: null, acuteMedDays30: 0, gaps: { missingSleepDays: 9, missingFoodDays: 2, unsplitFoodEntries: 0 } };
  assert.match(ruleSuggestion(stats, []).keep_logging, /Sleep is missing on 9 days/);
  stats.gaps = { missingSleepDays: 1, missingFoodDays: 2, unsplitFoodEntries: 12 };
  assert.match(ruleSuggestion(stats, []).keep_logging, /12 older food entries/);
});

test("ruleSuggestion tolerates missing pastTrials and malformed trials", () => {
  const stats = buildStats(fixture(), { now: nowAfter(140) });
  assertValid(ruleSuggestion(stats));
  assertValid(ruleSuggestion(stats, [null, {}, { status: "completed" }, { suggestion: {}, status: "completed", result: { before: 1, during: 1 } }]));
});

test("the label and key lists match the server's food vocabulary", () => {
  assert.deepEqual(Object.keys(TAG_LABELS).sort(), [...TRIGGER_TAGS].sort());
  const stats = buildStats(daysOf({
    0: FOOD_TYPES.map((food_type) => food("12:00", item(`f ${food_type}`, { food_type }))),
    1: [headache("10:00")],
  }), { now: nowAfter(5) });
  for (const type of FOOD_TYPES) assert.ok(factor(stats, `type:${type}`), type);
});

test("patterns.js pulls in no browser or data modules", () => {
  const read = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), "utf8");
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, target] of read(file).matchAll(/from\s*["']\.\/([^"']+)["']/g)) walk(target);
  };
  walk("patterns.js");
  assert.deepEqual([...seen].sort(), ["dates.js", "food-items.js", "headache.js", "patterns.js"]);
  assert.doesNotMatch(read("patterns.js"), /\bdocument\.|\bwindow\.\w|\blocalStorage\b|\bfetch\(/);
  assert.doesNotMatch(read("patterns.js"), /main_macro/, "main_macro is never read");
});

// mulberry32: small, fast and seeded, so the simulations give the same answer every run.
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Full logging, with `foods` eaten at random and attacks at random.
function simulate(random, { nDays, pHeadache, nFoods, pFood, signal = null }) {
  const days = [];
  for (let n = 0; n < nDays; n++) {
    const items = [];
    for (let f = 0; f < nFoods; f++) if (random() < pFood) items.push(item(`food${f}`));
    const entries = [sleep(8), food("12:00", ...items)];
    const attack = random() < pHeadache;
    if (attack) entries.push(headache("18:00"));
    days.push({ date: date(n), entries });
    if (signal && attack && random() < signal) days[n].entries[1].items.push(item("trigger"));
  }
  return buildStats(days, { now: nowAfter(nDays + 30) });
}

test("on pure noise, moderate or strong stays rare", () => {
  const scenarios = [
    { nDays: 42, pHeadache: 0.12, nFoods: 30, pFood: 0.15 },
    { nDays: 60, pHeadache: 0.12, nFoods: 40, pFood: 0.15 },
    { nDays: 90, pHeadache: 0.10, nFoods: 40, pFood: 0.15 },
    { nDays: 90, pHeadache: 0.10, nFoods: 40, pFood: 0.30 },
    { nDays: 365, pHeadache: 0.15, nFoods: 60, pFood: 0.20 },
  ];
  const runs = 200;
  scenarios.forEach((scenario, i) => {
    const random = prng(1000 + i);
    let confident = 0, strong = 0, anyFactor = 0;
    for (let r = 0; r < runs; r++) {
      const stats = simulate(random, scenario);
      const { confidence } = ruleSuggestion(stats, []).try_next;
      if (confidence !== "early guess") confident++;
      if (confidence === "strong") strong++;
      if (stats.factors.some((f) => f.confidence !== "early guess")) anyFactor++;
    }
    assert.ok(confident / runs <= 0.05, `try_next ${confident}/${runs} in scenario ${i}`);
    assert.ok(anyFactor / runs <= 0.05, `any factor ${anyFactor}/${runs} in scenario ${i}`);
    assert.ok(strong / runs <= 0.03, `strong ${strong}/${runs} in scenario ${i}`);
  });
});

// Foods run in streaks and attacks in clusters, independent of each other.
function simulateStreaks(random, { nDays, nFoods, foodLength, clusterLength, pFood = 0.15, pCluster = 0.03 }) {
  const eating = Array(nFoods).fill(false);
  let inCluster = false;
  const days = [];
  for (let n = 0; n < nDays; n++) {
    const items = [];
    for (let f = 0; f < nFoods; f++) {
      eating[f] = eating[f] ? random() >= 1 / foodLength : random() < pFood / (foodLength * (1 - pFood));
      if (eating[f]) items.push(item(`food${f}`));
    }
    inCluster = inCluster ? random() >= 1 / clusterLength : random() < pCluster;
    const entries = [sleep(8), food("12:00", ...items)];
    if (inCluster) entries.push(headache("18:00"));
    days.push({ date: date(n), entries });
  }
  return buildStats(days, { now: nowAfter(nDays + 30) });
}

test("on streaky noise, moderate or strong stays at or below 10%", () => {
  const scenarios = [
    { nDays: 180, nFoods: 40, foodLength: 4, clusterLength: 3.5 },
    { nDays: 365, nFoods: 60, foodLength: 4, clusterLength: 3.5 },
    { nDays: 365, nFoods: 60, foodLength: 7.5, clusterLength: 4.5 },
  ];
  const runs = 100;
  scenarios.forEach((scenario, i) => {
    const random = prng(2000 + i);
    let confident = 0;
    for (let r = 0; r < runs; r++) {
      if (simulateStreaks(random, scenario).factors.some((f) => f.confidence !== "early guess")) confident++;
    }
    assert.ok(confident / runs <= 0.1, `${confident}/${runs} in scenario ${i}`);
  });
});

test("a real signal of 6 of 8 against 2 of 40 survives 300 other factors", () => {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = n % 2 ? [note()] : [rice()];
  log[0].push(food("12:00", item("trigger"))); log[2].push(food("12:00", item("trigger")));
  for (let i = 0; i < 8; i++) {
    const noise = Array.from({ length: 300 }, (_, f) => f).filter((f) => f % 8 === i).map((f) => item(`noise ${f}`));
    log[81 + i * 10] = [headache("10:00"), food("08:00", ...noise, ...(i < 6 ? [item("trigger")] : []))];
  }
  const stats = buildStats(daysOf(log), { now: nowAfter(170) });
  const f = factor(stats, "food:trigger");
  assert.ok(stats.factors.length > 300);
  assert.deepEqual([f.beforeHeadache, f.headacheTotal, f.controlHits, f.controlTotal], [6, 8, 2, 40]);
  assert.notEqual(f.confidence, "early guess");
  assert.equal(ruleSuggestion(stats, []).try_next.factor_key, "food:trigger");
});

test("a simulated trigger rises above the noise", () => {
  const random = prng(7);
  let found = 0;
  const runs = 50;
  for (let r = 0; r < runs; r++) {
    const stats = simulate(random, { nDays: 120, pHeadache: 0.1, nFoods: 40, pFood: 0.15, signal: 0.8 });
    if (stats.factors.find((f) => f.key === "food:trigger" && f.confidence !== "early guess")) found++;
  }
  assert.ok(found / runs >= 0.6, `found in ${found} of ${runs}`);
});

test("the same log gives the same results in UTC and in New York", () => {
  const url = new URL("../public/js/patterns.js", import.meta.url).href;
  const headacheUrl = new URL("../public/js/headache.js", import.meta.url).href;
  const script = `
    import { buildStats, ruleSuggestion } from ${JSON.stringify(url)};
    import { headacheDaySet } from ${JSON.stringify(headacheUrl)};
    const it = (name) => ({ name, food_type: "dairy", tags: [] });
    const food = (time, name) => ({ type: "food", time, split_status: "done", items: [it(name)] });
    const days = [
      { date: "2026-03-09", entries: [food("23:30", "late snack"), { type: "note", time: "09:00" }] },
      // Logged in New York: 10:00 local is 14:00Z, and lunch is after the attack.
      { date: "2026-03-10", entries: [food("12:00", "after attack"), { type: "headache", time: "10:00", start_at: "2026-03-10T14:00:00.000Z", end_at: "2026-03-10T15:00:00.000Z" }] },
      { date: "2026-03-20", entries: [food("12:00", "toast")] },
      // 20 days apart across the end of daylight saving: one period, not two.
      { date: "2026-10-20", entries: [{ type: "period", time: "08:00" }] },
      { date: "2026-11-09", entries: [{ type: "period", time: "08:00" }] },
      // 22:00 local is 02:00Z the next day. It ends at 23:30 local, the same date.
      { date: "2026-03-24", entries: [{ type: "headache", time: "22:00", start_at: "2026-03-25T02:00:00.000Z", end_at: "2026-03-25T03:30:00.000Z" }] },
      // 22:00 local to 01:00 local crosses midnight.
      { date: "2026-03-28", entries: [{ type: "headache", time: "22:00", start_at: "2026-03-29T02:00:00.000Z", end_at: "2026-03-29T05:00:00.000Z" }] },
    ];
    const now = new Date("2026-04-02T03:00:00Z");
    const stats = buildStats(days, { now });
    console.log(JSON.stringify({ stats, suggestion: ruleSuggestion(stats, []), dates: [...headacheDaySet(days)] }));
  `;
  const run = (TZ) => execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ }, encoding: "utf8" });
  const utc = run("UTC");
  assert.equal(utc, run("America/New_York"));
  assert.equal(utc, run("Asia/Tokyo"));
  const { stats, dates } = JSON.parse(utc);
  assert.deepEqual(dates, ["2026-03-10", "2026-03-24", "2026-03-28", "2026-03-29"]);
  assert.deepEqual(stats.factors.filter((f) => f.key.startsWith("food:")).map((f) => f.key), ["food:late snack"]);
  assert.equal(stats.cycle.periodStarts, 1);
});
