import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INSIGHT_SCHEMA,
  MAX_PROMPT_FACTORS,
  fitToStats,
  promptFactors,
  validateInsight,
} from "../netlify/functions/lib/insight.js";
import { LOG_CHAR_CAP, LOG_DAYS, analyzeContent, formatLog } from "../netlify/functions/lib/prompts.js";
import { buildStats, mentionsMedicine, ruleSuggestion } from "../public/js/patterns.js";
import { foodNames } from "../public/js/food-items.js";
import { setBackend } from "../public/js/data.js";
import { freqChart, renderInsight, requestInsight, rollUpDays, showSavedInsight } from "../public/js/insights.js";

const insight = (tryNext = {}, rest = {}) => ({
  try_next: {
    title: "Skip cheddar for 2 weeks",
    action: "Do this for the next 2 weeks",
    why: "Cheddar came before 4 of 5 headaches.",
    confidence: "moderate",
    days: 14,
    factor_key: "food:cheddar",
    ...tryNext,
  },
  also_watching: [{ item: "Red wine", evidence: "Before 2 of 5 headaches." }],
  keep_logging: "Sleep is missing on 9 days.",
  doctor_questions: ["Should I look at my triptan use?"],
  cycle_note: null,
  medication_note: null,
  ...rest,
});

// ---------- validateInsight ----------

test("a sound result comes back with only the known fields", () => {
  const good = insight();
  assert.deepEqual(validateInsight({ ...good, extra: "<b>" }, { medNames: [] }), good);
});

test("no try_next, or a broken one, returns null", () => {
  assert.equal(validateInsight(null, {}), null);
  assert.equal(validateInsight({ ...insight(), try_next: undefined }, {}), null);
  assert.equal(validateInsight({ ...insight(), try_next: null }, {}), null);
  assert.equal(validateInsight(insight({ title: "" }), {}), null);
  assert.equal(validateInsight(insight({ action: 7 }), {}), null);
  assert.equal(validateInsight(insight({ confidence: "low" }), {}), null);
});

test("days must be a whole number from 7 to 28", () => {
  for (const days of [6, 29, 14.5, "14", null]) assert.equal(validateInsight(insight({ days }), {}), null, String(days));
  for (const days of [7, 28]) assert.equal(validateInsight(insight({ days }), {}).try_next.days, days);
});

test("a missing factor_key reads as null", () => {
  assert.equal(validateInsight(insight({ factor_key: undefined }), {}).try_next.factor_key, null);
});

for (const phrase of [
  "Stop taking your preventive",
  "Try a lower DOSE",
  "start taking magnesium",
  "Increase your intake",
  "Reduce your medication",
  "Skip your rescue meds for a while",
]) {
  test(`try_next cannot say: ${phrase}`, () => {
    for (const field of ["title", "action", "why"]) {
      assert.equal(validateInsight(insight({ [field]: phrase }), { medNames: [] }), null, field);
    }
  });
}

test("try_next and also_watching cannot name a med, logged or built in", () => {
  const medNames = ["Topiramate 50mg", "Zofran"];
  for (const name of ["topiramate", "ZOFRAN", "Advil", "rizatriptan"]) {
    const text = `Go without ${name} for 2 weeks`;
    assert.equal(validateInsight(insight({ title: text }), { medNames }), null, name);
    assert.equal(validateInsight(insight({}, { also_watching: [{ item: name, evidence: "x" }] }), { medNames }), null, name);
    assert.equal(validateInsight(insight({}, { also_watching: [{ item: "x", evidence: text }] }), { medNames }), null, name);
  }
});

test("med names match whole words, so a food that holds one survives", () => {
  assert.ok(validateInsight(insight({ title: "Skip almonds" }), { medNames: ["Alm"] }));
  assert.equal(mentionsMedicine("skip almonds", ["alm"]), false);
  assert.equal(mentionsMedicine("skip alms", ["alm"]), true);
});

for (const text of [
  "Cut carbs for 2 weeks",
  "Cut out all protein",
  "Avoid fat",
  "Try a low-carb diet",
  "Eat less fat",
  "Go carb-free for 2 weeks",
  "Remove a whole macronutrient",
  "Skip carbohydrates at dinner",
]) {
  test(`whole macronutrient advice is refused: ${text}`, () => {
    assert.equal(validateInsight(insight({ title: text }), {}), null);
    assert.equal(validateInsight(insight({}, { also_watching: [{ item: "x", evidence: text }] }), {}), null);
  });
}

test("naming a macro without cutting it, or cutting one food, is fine", () => {
  for (const title of ["Skip cheddar for 2 weeks", "Add protein at breakfast", "Skip fatty sausage"]) {
    assert.ok(validateInsight(insight({ title }), {}), title);
  }
});

test("doctor questions and the medication note may mention medicines", () => {
  const result = insight({}, {
    doctor_questions: ["Should I stop taking topiramate, or change the dose?"],
    medication_note: "You logged advil on 9 of the last 30 days.",
  });
  assert.deepEqual(validateInsight(result, { medNames: ["Topiramate"] }), result);
});

test("the other fields keep their shape", () => {
  assert.equal(validateInsight({ ...insight(), also_watching: "x" }, {}), null);
  assert.equal(validateInsight({ ...insight(), also_watching: [{ item: "x" }] }, {}), null);
  assert.equal(validateInsight({ ...insight(), doctor_questions: [1] }, {}), null);
  assert.equal(validateInsight({ ...insight(), keep_logging: null }, {}), null);
  assert.equal(validateInsight({ ...insight(), cycle_note: 5 }, {}), null);
});

test("a saved name with more than one word is caught by its distinctive word", () => {
  for (const [title, name] of [
    ["Skip Nurtec for 2 weeks", "Nurtec ODT"],
    ["Stop zofran", "Zofran ODT"],
    ["Pause your magnesium", "Magnesium glycinate"],
    ["Pause your glycinate", "Magnesium glycinate"],
    ["Skip Excedrin", "Excedrin Migraine"],
    ["Try Xylofen again", "Xylofen Nasal Spray"],
  ]) {
    assert.equal(validateInsight(insight({ title }), { medNames: [name] }), null, title);
    assert.equal(validateInsight(insight({}, { keep_logging: title }), { medNames: [name] }), null, title);
  }
});

test("the form words of a saved name do not count as the medicine", () => {
  const medNames = ["Excedrin Migraine", "Sleep Aid", "Nurtec ODT", "Xylofen Nasal Spray", "Tablet Thing"];
  for (const title of ["Log every migraine for 2 weeks", "Aim for 7+ hours of sleep", "Note any nasal symptoms"]) {
    assert.ok(validateInsight(insight({ title }), { medNames }), title);
  }
});

test("saved names do not change which foods count as factors", () => {
  assert.equal(mentionsMedicine("skip nurtec", ["Nurtec ODT"]), false);
  assert.equal(mentionsMedicine("skip nurtec odt", ["Nurtec ODT"]), true);
});

for (const title of [
  "Stop your preventive",
  "Double up on your preventive",
  "Skip your rescue inhaler",
  "Use your painkillers earlier",
  "Stop your prescription",
  "Take fewer tablets",
  "Try feverfew capsules",
  "Try a magnesium supplement",
  "Take riboflavin every morning",
  "Try 400 mg of magnesium at night",
  "Try 400mg at night",
  "Stop Imitrex",
  "Avoid over-the-counter drugs",
]) {
  test(`medication wording is refused: ${title}`, () => {
    assert.equal(validateInsight(insight({ title }), { medNames: [] }), null);
    assert.equal(validateInsight(insight({}, { also_watching: [{ item: "x", evidence: title }] }), { medNames: [] }), null);
  });
}

test("a plain number is not a medicine amount", () => {
  assert.ok(validateInsight(insight({ title: "Drink 400 ml of water at night" }), {}));
  assert.ok(validateInsight(insight({ title: "Sleep 8 hours for 14 nights" }), {}));
});

for (const title of [
  "Don't eat carbs",
  "Stay away from carbs",
  "Banish carbs",
  "Fast from carbs",
  "Replace carbs with vegetables",
  "Cut out all of your carbs",
  "Stop eating anything with fat",
  "Go without carbohydrates",
  "Zero-carb diet",
  "Eat meals with fewer carbs",
  "Add protein and drop the carbs",
  "Try a keto diet",
  "Try a ketogenic diet",
  "Try the carnivore diet",
  "Try the Atkins diet",
]) {
  test(`whole macronutrient wording is refused: ${title}`, () => {
    assert.equal(validateInsight(insight({ title }), {}), null);
  });
}

test("macro words pass only in an adding form", () => {
  for (const title of ["Add protein at breakfast", "Eat more protein at lunch", "Pair fruit with protein", "Add some fat to lunch"]) {
    assert.ok(validateInsight(insight({ title }), {}), title);
  }
  for (const title of ["Have your protein at lunch", "Watch your fat"]) {
    assert.equal(validateInsight(insight({ title }), {}), null, title);
  }
});

test("cycle_note and keep_logging get the full scan", () => {
  const medNames = ["Topiramate"];
  assert.equal(validateInsight(insight({}, { cycle_note: "Start taking naproxen two days before your period." }), { medNames }), null);
  assert.equal(validateInsight(insight({}, { keep_logging: "Stop taking your preventive and log how it goes." }), { medNames }), null);
  for (const field of ["cycle_note", "keep_logging"]) {
    for (const value of ["Topiramate is worth logging.", "Log your meds.", "Cut carbs before your period."]) {
      assert.equal(validateInsight(insight({}, { [field]: value }), { medNames }), null, `${field}: ${value}`);
    }
  }
});

test("medication_note refuses instructions but may still name medicines", () => {
  const medNames = ["Topiramate"];
  for (const medication_note of [
    "Stop taking Advil and raise your Topiramate dose.",
    "Start taking Topiramate daily.",
    "Lower the dose.",
    "Raising your dosage may help.",
  ]) {
    assert.equal(validateInsight(insight({}, { medication_note }), { medNames }), null, medication_note);
  }
  const fine = insight({}, { medication_note: "You logged Topiramate and Advil on 9 of the last 30 days. Your dose is worth raising with your doctor." });
  assert.ok(validateInsight(fine, { medNames }));
});

test("doctor_questions stay unscanned", () => {
  const result = insight({}, { doctor_questions: ["Should I stop taking Advil, raise my Topiramate dose or try keto?"] });
  assert.deepEqual(validateInsight(result, { medNames: ["Topiramate"] }), result);
});

// ---------- INSIGHT_SCHEMA ----------

test("INSIGHT_SCHEMA is strict and follows the spec, with factor_key added", () => {
  const { properties: top } = INSIGHT_SCHEMA;
  assert.deepEqual(Object.keys(top).sort(), ["also_watching", "cycle_note", "doctor_questions", "keep_logging", "medication_note", "try_next"]);
  assert.deepEqual([...INSIGHT_SCHEMA.required].sort(), Object.keys(top).sort());
  assert.equal(INSIGHT_SCHEMA.additionalProperties, false);
  const next = top.try_next;
  assert.deepEqual(Object.keys(next.properties).sort(), ["action", "confidence", "days", "factor_key", "title", "why"]);
  assert.deepEqual(next.properties.confidence.enum, ["early guess", "moderate", "strong"]);
  assert.equal(next.properties.days.type, "integer");
  assert.deepEqual(next.properties.factor_key.anyOf.map((o) => o.type), ["string", "null"]);
  assert.equal(next.additionalProperties, false);
});

// ---------- Rule output against the same check ----------

// Six attacks with one food before each, plus quiet days, so factors are real.
function loggedDays({ food = "cheddar", tags = [], foodType = "dairy", sleepBefore = 8 } = {}) {
  const days = [];
  const date = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
  for (let n = 0; n < 80; n++) {
    const attack = n % 10 === 5;
    const before = n % 10 === 4;
    const entries = [
      { type: "sleep", time: "07:00", hours: before ? sleepBefore : 8 },
      { type: "food", time: "12:00", split_status: "done", text: "lunch",
        items: [{ name: before ? food : "rice", food_type: before ? foodType : "grains", tags: before ? tags : [] }] },
    ];
    if (attack) entries.push({ type: "headache", time: "15:00", severity: 5 });
    days.push({ date: date(n), entries });
  }
  return days;
}

test("every kind of rule suggestion passes validateInsight with the app's own wording", () => {
  const logs = {
    nothing: [],
    "no headaches": [{ date: "2026-01-01", entries: [{ type: "note", text: "x" }] }],
    food: loggedDays(),
    tag: loggedDays({ food: "gouda", tags: ["aged_cheese"] }),
    caffeine: loggedDays({ food: "coffee", tags: ["caffeine"], foodType: "drinks" }),
    "broad group": loggedDays({ food: "bread", foodType: "grains" }),
    sleep: loggedDays({ food: "rice", foodType: "grains", sleepBefore: 5 }),
  };
  const medNames = ["Topiramate"];
  for (const [name, days] of Object.entries(logs)) {
    const result = ruleSuggestion(buildStats(days, { today: "2026-06-01", medNames }), []);
    assert.deepEqual(validateInsight(result, { medNames }), result, name);
  }
});

test("rule notes pass the full scan: cycle, medication and every keep_logging wording", () => {
  const notes = [
    { missingSleepDays: 0, missingFoodDays: 0, unsplitFoodEntries: 0 },
    { missingSleepDays: 9, missingFoodDays: 1, unsplitFoodEntries: 0 },
    { missingSleepDays: 1, missingFoodDays: 9, unsplitFoodEntries: 0 },
    { missingSleepDays: 1, missingFoodDays: 1, unsplitFoodEntries: 1 },
    { missingSleepDays: 1, missingFoodDays: 1, unsplitFoodEntries: 9 },
  ];
  for (const gaps of notes) {
    const stats = { loggedDays: 40, attacks: 6, headacheDays: 6, factors: [], acuteMedDays30: 12, gaps,
      cycle: { periodStarts: 2, byCycleDay: { "+1": 5, "+9": 1 }, counted: 6, nearPeriod: 5 } };
    const result = ruleSuggestion(stats, []);
    assert.ok(result.cycle_note);
    assert.ok(result.medication_note);
    assert.deepEqual(validateInsight(result, { medNames: ["Topiramate"] }), result, result.keep_logging);
  }
});

test("the habit fallback passes too", () => {
  const stats = { loggedDays: 40, attacks: 5, headacheDays: 5, factors: [{ key: "food:x", label: "X", beforeHeadache: 1, headacheTotal: 5, controlHits: 9, controlTotal: 20, confidence: "early guess" }], cycle: null, acuteMedDays30: 9, gaps: { missingSleepDays: 0, missingFoodDays: 0, unsplitFoodEntries: 0 } };
  const result = ruleSuggestion(stats, []);
  assert.match(result.try_next.factor_key, /^habit:/);
  assert.ok(validateInsight(result, { medNames: [] }));
});

// ---------- Factors sent to Claude ----------

const factor = (key, beforeHeadache, controlHits, confidence = "early guess") => ({
  key, label: key, beforeHeadache, headacheTotal: 10, controlHits, controlTotal: 20, confidence,
});

test("a factor whose plain counts lean away from headaches is not sent, whatever its label", () => {
  const stats = { factors: [factor("food:a", 3, 16, "strong"), factor("food:b", 5, 10), factor("food:c", 6, 2)] };
  assert.deepEqual(promptFactors(stats).map((f) => f.key), ["food:c"]);
});

test("a factor with no control windows is not sent, and neither is plenty of sleep", () => {
  const noControl = { ...factor("food:a", 5, 0), controlTotal: 0 };
  assert.deepEqual(promptFactors({ factors: [noControl, factor("sleep:7_plus", 9, 2)] }), []);
});

test("at most 40 factors go, best evidence first", () => {
  const factors = Array.from({ length: 60 }, (_, i) => factor(`food:${i}`, 9, 1));
  assert.equal(MAX_PROMPT_FACTORS, 40);
  assert.deepEqual(promptFactors({ factors }).map((f) => f.key), factors.slice(0, 40).map((f) => f.key));
});

test("broad food groups are marked as doctor-only", () => {
  const [grains, dairy] = promptFactors({ factors: [factor("type:grains", 9, 1), factor("type:dairy", 9, 1)] });
  assert.equal(grains.doctor_only, true);
  assert.equal(dairy.doctor_only, undefined);
});

// ---------- Confidence comes from the engine ----------

test("confidence is the engine's when factor_key matches", () => {
  const out = fitToStats(insight({ confidence: "strong", factor_key: "food:a" }), [factor("food:a", 9, 1, "moderate")]);
  assert.equal(out.try_next.confidence, "moderate");
  const raised = fitToStats(insight({ confidence: "early guess", factor_key: "food:a" }), [factor("food:a", 9, 1, "strong")]);
  assert.equal(raised.try_next.confidence, "strong");
});

test("confidence is forced to early guess when factor_key matches nothing", () => {
  for (const factor_key of ["food:unknown", null]) {
    const out = fitToStats(insight({ confidence: "strong", factor_key }), [factor("food:a", 9, 1, "strong")]);
    assert.equal(out.try_next.confidence, "early guess");
  }
});

test("a suggestion aimed at a broad food group is refused", () => {
  assert.equal(fitToStats(insight({ factor_key: "type:grains" }), [factor("type:grains", 9, 1)]), null);
  assert.ok(fitToStats(insight({ factor_key: "type:dairy" }), [factor("type:dairy", 9, 1)]));
});

test("fitToStats passes null through", () => {
  assert.equal(fitToStats(null, []), null);
});

// ---------- The compact log ----------

const row = (date, type, data, time = "08:00") => ({ date, time, type, data });

test("the log uses food items where it has them and the text where it does not", () => {
  const log = formatLog([
    row("2026-03-01", "food", { text: "cheese toast", split_status: "done", items: [{ name: "bread", protein_g: 4 }, { name: "cheddar" }, { name: "ham", removed: true, edited: true }] }),
    row("2026-03-01", "food", { text: "old line" }),
    row("2026-03-02", "sleep", { hours: 7 }, null),
  ], { today: "2026-03-03" });
  assert.equal(log, 'LOG DATA:\n2026-03-01: [food 08:00 ["bread","cheddar"]] [food 08:00 ["old line"]]\n2026-03-02: [sleep {"hours":7}]');
});

test("the log covers the last 120 days only", () => {
  assert.equal(LOG_DAYS, 120);
  const log = formatLog([row("2026-02-28", "note", { text: "too old" }), row("2026-03-01", "note", { text: "oldest kept" })], { today: "2026-06-28" });
  assert.doesNotMatch(log, /too old/);
  assert.match(log, /oldest kept/);
});

test("the log stays under the cap by cutting the oldest days first", () => {
  assert.equal(LOG_CHAR_CAP, 60_000);
  const rows = Array.from({ length: 90 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    return row(date, "note", { text: "x".repeat(1000) });
  });
  const log = formatLog(rows, { today: "2026-04-15" });
  assert.ok(log.length <= LOG_CHAR_CAP + 100, String(log.length));
  assert.ok(log.length > 50_000, String(log.length));
  assert.doesNotMatch(log, /2026-01-01:/);
  assert.match(log, /2026-03-31:/);
  assert.match(log, /left out/);
});

test("the message holds the stats, the past trials and the log", () => {
  const content = analyzeContent({ stats: { attacks: 2 }, pastTrials: [{ status: "completed" }], log: "LOG DATA:\nx" });
  assert.match(content, /STATS:\n\{"attacks":2\}/);
  assert.match(content, /PAST TRIALS:\n\[\{"status":"completed"\}\]/);
  assert.match(content, /LOG DATA:\nx/);
});

// ---------- The food chart ----------

test("foodNames gives items, skips deleted ones and falls back to old text", () => {
  assert.deepEqual(foodNames({ text: "toast and cheddar", items: [{ name: "Toast " }, { name: "cheddar" }, { name: "ham", removed: true }] }), ["toast", "cheddar"]);
  assert.deepEqual(foodNames({ text: " Old Line " }), ["old line"]);
  assert.deepEqual(foodNames({ text: "pending", split_status: "pending", items: [] }), ["pending"]);
});

test("foodNames does not bring back deleted food, or food the split found none in", () => {
  assert.deepEqual(foodNames({ text: "ham", items: [{ name: "ham", removed: true }] }), []);
  assert.deepEqual(foodNames({ text: "went for a walk", split_status: "done", items: [] }), []);
  assert.deepEqual(foodNames({}), []);
});

test("the food chart counts items rather than whole lines", () => {
  const days = [
    { date: "2026-03-01", entries: [
      { type: "headache", time: "09:00" },
      { type: "food", text: "cheddar toast", items: [{ name: "cheddar" }, { name: "toast" }] },
      { type: "food", text: "more cheddar", items: [{ name: "cheddar" }] },
    ] },
    { date: "2026-03-02", entries: [
      { type: "headache", time: "09:00" },
      { type: "food", text: "a cheddar omelette", items: [{ name: "Cheddar" }, { name: "egg" }] },
      { type: "food", text: "Old Line" },
    ] },
  ];
  const html = freqChart(rollUpDays(days).filter((d) => d.hasHeadache), (d) => d.foods, "red");
  const bars = [...html.matchAll(/class="label">([^<]+)<[\s\S]*?class="bar-val">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(bars, [["cheddar", "2/2"], ["toast", "1/2"], ["egg", "1/2"], ["old line", "1/2"]]);
});

// ---------- renderInsight ----------

function fakeDom() {
  const made = [], innerHtml = [];
  class El {
    kids = []; text = ""; className = "";
    constructor(tag) { this.tag = tag; made.push(tag); this.ownerDocument = doc; }
    set textContent(value) { this.text = String(value); this.kids = []; }
    get textContent() { return this.text + this.kids.map((k) => k.textContent).join(" "); }
    set innerHTML(value) { innerHtml.push(value); }
    append(...kids) { this.kids.push(...kids); }
    replaceChildren(...kids) { this.kids = kids; }
    addEventListener() {}
  }
  const doc = { createElement: (tag) => new El(tag) };
  const container = new El("div");
  made.length = 0;
  return { container, made, innerHtml };
}

const fullInsight = (evil = "plain") => ({
  try_next: { title: `${evil} title`, action: `${evil} action`, why: `${evil} why`, confidence: "moderate", days: 14, factor_key: null },
  also_watching: [{ item: `${evil} item`, evidence: `${evil} evidence` }],
  keep_logging: `${evil} keep`,
  doctor_questions: [`${evil} question`],
  cycle_note: `${evil} cycle`,
  medication_note: `${evil} medication`,
});

test("renderInsight shows the mockup's sections", () => {
  const { container } = fakeDom();
  renderInsight(fullInsight(), container);
  const text = container.textContent;
  for (const part of ["Try this next", "Also watching", "Keep logging", "doctor", "plain title", "plain action", "plain why", "moderate", "14 days", "plain item", "plain evidence", "plain keep", "plain question", "plain cycle", "plain medication"]) {
    assert.ok(text.includes(part), part);
  }
});

test("renderInsight puts markup in as text and creates no element from it", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const { container, made, innerHtml } = fakeDom();
  renderInsight(fullInsight(evil), container);
  assert.deepEqual(innerHtml, []);
  assert.equal(made.includes("img"), false);
  assert.ok(container.textContent.includes(`${evil} title`));
  assert.ok(container.textContent.includes(`${evil} evidence`));
});

test("renderInsight replaces what was there and leaves out empty sections", () => {
  const { container } = fakeDom();
  container.append({ textContent: "old result" });
  renderInsight({ ...fullInsight(), also_watching: [], doctor_questions: [], cycle_note: null, medication_note: null }, container);
  const text = container.textContent;
  assert.equal(text.includes("old result"), false);
  assert.equal(text.includes("Also watching"), false);
  assert.equal(text.includes("doctor"), false);
  assert.equal(text.includes("null"), false);
});

test("renderInsight offers Start this only when given a way to start", () => {
  const without = fakeDom(), withStart = fakeDom();
  renderInsight(fullInsight(), without.container);
  renderInsight({ ...fullInsight(), source: "rules" }, withStart.container, { onStart: () => {} });
  assert.doesNotMatch(without.container.textContent, /Start this/);
  assert.match(withStart.container.textContent, /Start this/);
});

test("renderInsight says when a result came from the app's own counts", () => {
  const rules = fakeDom(), ai = fakeDom();
  renderInsight({ ...fullInsight(), source: "rules" }, rules.container);
  renderInsight({ ...fullInsight(), source: "ai" }, ai.container);
  assert.match(rules.container.textContent, /own counts/);
  assert.doesNotMatch(ai.container.textContent, /own counts/);
});

test("the not-a-diagnosis note stays, above sleep, cycle, food and meds charts", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /not a diagnosis/);
  const output = html.indexOf('id="aiOutput"');
  for (const id of ["sleepChart", "cycleChart", "foodChart", "medChart"]) {
    assert.ok(html.indexOf(`id="${id}"`) > output, id);
  }
});

// ---------- Saving and loading ----------

function fakeBackend(overrides = {}) {
  const calls = { ai: [], saved: [] };
  setBackend({
    ai: async (action, payload) => { calls.ai.push([action, payload]); return { result: fullInsight(), source: "ai" }; },
    saveInsight: async (result) => { calls.saved.push(result); },
    getInsight: async () => null,
    listAll: async () => [],
    listMeds: async () => [],
    ...overrides,
  });
  return calls;
}

test("a saved result loads without an AI call", async () => {
  const calls = fakeBackend({ getInsight: async () => ({ result: fullInsight("saved"), created_at: "2026-11-01" }) });
  const { container } = fakeDom();
  await showSavedInsight(container);
  assert.ok(container.textContent.includes("saved title"));
  assert.deepEqual(calls.ai, []);
});

test("nothing saved, a bad row or a failed read leaves the screen alone", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const getInsight of [async () => null, async () => ({ result: {} }), async () => { throw new Error("no table"); }]) {
    fakeBackend({ getInsight });
    const { container } = fakeDom();
    await showSavedInsight(container);
    assert.equal(container.textContent, "");
  }
});

test("analyzing sends today, and saves the result with its source", async () => {
  const calls = fakeBackend();
  const out = await requestInsight("2026-11-05");
  assert.deepEqual(calls.ai, [["analyze", { today: "2026-11-05" }]]);
  assert.equal(out.source, "ai");
  assert.deepEqual(calls.saved, [out]);
});

test("a failed save only logs, and the result still appears", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  fakeBackend({ saveInsight: async () => { throw new Error("no table"); } });
  const out = await requestInsight("2026-11-05");
  assert.equal(out.source, "ai");
  assert.equal(log.mock.callCount(), 1);
});

test("if the network call fails, the rules run in the browser and nothing is saved", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fakeBackend({ ai: async () => { throw new Error("offline"); }, listAll: async () => loggedDays(), listMeds: async () => [{ name: "Topiramate" }] });
  const out = await requestInsight("2026-06-01");
  assert.equal(out.source, "rules");
  assert.ok(validateInsight(out, { medNames: [] }));
  assert.match(out.try_next.title, /cheddar|Dairy|sleep/i);
  assert.deepEqual(calls.saved, []);
});

test("a response with no suggestion in it also falls back to the rules", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fakeBackend({ ai: async () => ({ text: "old shape" }) });
  assert.equal((await requestInsight("2026-06-01")).source, "rules");
  assert.deepEqual(calls.saved, []);
});

test("a failed read after a failed network call is an error, not a made-up empty log", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeBackend({ ai: async () => { throw new Error("offline"); }, listAll: async () => { throw new Error("offline"); } });
  await assert.rejects(requestInsight("2026-06-01"));
});
