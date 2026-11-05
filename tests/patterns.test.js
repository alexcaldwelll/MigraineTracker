import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildStats, confidenceFor, ruleSuggestion } from "../public/js/patterns.js";
import { TAG_LABELS } from "../public/js/food-items.js";
import { FOOD_TYPES, TRIGGER_TAGS } from "../netlify/functions/lib/food.js";
import { shiftDate } from "../public/js/dates.js";

const BASE = "2026-01-01";
const date = (n) => shiftDate(BASE, n);
const nowAfter = (n) => new Date(`${date(n)}T12:00:00`);

let nextId = 0;
const item = (name, over = {}) => ({ name, main_macro: "fat", food_type: "other", protein_g: 1, carbs_g: 1, fat_g: 1, tags: [], ...over });
const food = (time, ...items) => ({ id: `e${nextId++}`, type: "food", time, text: "lunch", split_status: "done", items });
const headache = (time, over = {}) => ({ id: `e${nextId++}`, type: "headache", time, ...over });
const sleep = (hours, time = "07:00") => ({ id: `e${nextId++}`, type: "sleep", time, hours });
const note = () => ({ id: `e${nextId++}`, type: "note", time: "09:00", text: "fine" });

// { 0: [entries], 3: [entries] } -> days, keyed by offset from BASE.
const daysOf = (log) => Object.entries(log).map(([n, entries]) => ({ date: date(Number(n)), entries }));
const factor = (stats, key) => stats.factors.find((f) => f.key === key);

// 40 clean two-day spans (days 0 to 79, cheddar in 6), then five attacks on odd
// days 81 to 89, one day apart so no span fits, with cheddar before the first three.
function fixture(foodName = "cheddar", over = {}) {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = [note()];
  for (const n of [0, 2, 4, 6, 8, 10]) log[n].push(food("12:00", item(foodName, over)));
  for (const n of [81, 83, 85, 87, 89]) log[n] = [headache("10:00")];
  for (const n of [80, 82, 84]) log[n] = [food("20:00", item(foodName, over))];
  return daysOf(log);
}

// `hits` of 8 attacks follow the food; `controlHits` of 40 controls contain it.
function statsWith(name, hits, controlHits, over = {}) {
  const log = {};
  for (let n = 0; n < 80; n++) log[n] = [note()];
  for (let i = 0; i < controlHits; i++) log[i * 2].push(food("12:00", item(name, over)));
  for (let i = 0; i < 8; i++) {
    log[81 + i * 2] = [headache("10:00")];
    if (i < hits) log[80 + i * 2] = [food("20:00", item(name, over))];
  }
  return buildStats(daysOf(log), { now: nowAfter(120) });
}

test("a food in 3 of 5 lookbacks and 6 of 40 control windows reports those exact counts", () => {
  const stats = buildStats(fixture(), { now: nowAfter(100) });
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

test("start_at wins over date and time", () => {
  const start = new Date(`${date(5)}T09:00:00`).toISOString();
  const stats = buildStats(daysOf({
    0: [headache("20:00", { start_at: start })],
    4: [food("12:00", item("near start_at"))],
  }), { now: nowAfter(9) });
  assert.equal(factor(stats, "food:near start_at").beforeHeadache, 1);
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

test("confidenceFor needs repeated evidence, then a clear gap from the control rate", () => {
  assert.equal(confidenceFor(0, 0), "early guess");
  assert.equal(confidenceFor(2, 2), "early guess");
  assert.equal(confidenceFor(3, 8), "early guess");
  assert.equal(confidenceFor(3, 5), "moderate");
  assert.equal(confidenceFor(4, 5), "moderate");
  assert.equal(confidenceFor(5, 8), "strong");
  assert.equal(confidenceFor(5, 8, { hits: 4, total: 40 }), "strong");
  assert.equal(confidenceFor(5, 8, { hits: 16, total: 40 }), "moderate", "gap under 0.30");
  assert.equal(confidenceFor(5, 8, { hits: 24, total: 40 }), "early guess", "no real gap");
  assert.equal(confidenceFor(5, 8, { hits: 0, total: 6 }), "moderate", "too few control windows");
  assert.equal(confidenceFor(5, 8, { hits: 0, total: 0 }), "early guess", "nothing to compare with");
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
    0: [note()], 1: [note()],                 // a span
    2: [note()], 3: [headache("10:00")],      // day 2 cannot pair with a headache day
    4: [food("12:00", item("x"))], 5: [note()], // a span
    // 6 to 19 were never logged
    20: [note()],                             // pairs with day 19, a span of its own
    21: [note()],                             // today, so it pairs with nothing
  }), { now: nowAfter(21) });
  assert.equal(factor(stats, "food:x"), undefined, "seen only in a control window");
  const withHit = buildStats(daysOf({
    0: [note()], 1: [note()], 2: [food("12:00", item("x"))], 3: [headache("10:00")],
    4: [note()], 5: [note()], 20: [note()], 21: [note()],
  }), { now: nowAfter(20) });
  assert.equal(factor(withHit, "food:x").controlTotal, 2, "days 0-1 and 4-5; day 20 is today");
});

test("a log with no headache-free span has a control total of 0 and stays an early guess", () => {
  const log = {};
  for (let i = 0; i < 6; i++) log[i * 2] = [headache("10:00")];
  for (let i = 0; i < 5; i++) log[i * 2 + 1] = [food("12:00", item("coffee"))];
  const stats = buildStats(daysOf(log), { now: nowAfter(11) });
  const f = factor(stats, "food:coffee");
  assert.equal(f.controlTotal, 0);
  assert.equal(f.beforeHeadache, 5);
  assert.equal(f.confidence, "early guess");
  assert.match(ruleSuggestion(stats, []).try_next.why, /no headache-free/i);
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
  const result = ruleSuggestion(buildStats(fixture(), { now: nowAfter(100) }), []);
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

test("broad or vague groups are reported but never suggested", () => {
  for (const food_type of ["drinks", "other"]) {
    const stats = statsWith("mystery", 6, 2, { food_type });
    assert.ok(factor(stats, `type:${food_type}`));
    stats.factors = stats.factors.filter((f) => !f.key.startsWith("food:"));
    const result = ruleSuggestion(stats, []);
    assert.equal(result.try_next.factor_key?.startsWith("type:") ?? false, false);
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
  const stats = buildStats(fixture(), { now: nowAfter(100) });
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
