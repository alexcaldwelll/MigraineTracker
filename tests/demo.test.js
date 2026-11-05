import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createDemoBackend, DEMO_INSIGHT, SCREENSHOTS_OFF, demoSplitFood } from "../public/js/demo.js";
import { buildDemoData, DEMO_DAYS } from "../public/js/demo-data.js";
import { createSupabaseBackend, setBackend, data, isDemo } from "../public/js/data.js";
import { buildStats } from "../public/js/patterns.js";
import { shiftDate } from "../public/js/dates.js";
import { activeTrial } from "../public/js/trials.js";
import { validateInsight, INSIGHT_SCHEMA } from "../netlify/functions/lib/insight.js";
import { validateItems } from "../netlify/functions/lib/food.js";

const TODAY = "2026-11-05";
const methods = (backend) => Object.keys(backend).filter((k) => typeof backend[k] === "function").sort();

// Fails loudly if anything reaches the network or a Supabase client.
const throwingClient = new Proxy({}, { get() { throw new Error("Supabase was touched"); } });
const noFetch = () => { throw new Error("fetch was called"); };

test("the demo has every Backend method the real backend has, and no others", () => {
  assert.deepEqual(methods(createDemoBackend(TODAY)), methods(createSupabaseBackend(throwingClient)));
});

test("sample data covers 56+ days with an active and a completed trial", () => {
  const { days, trials, meds } = buildDemoData(TODAY);
  assert.ok(days.length >= 56);
  assert.equal(days[0].date, shiftDate(TODAY, -DEMO_DAYS));
  assert.equal(days.at(-1).date, TODAY);
  assert.equal(trials.filter((t) => t.status === "active").length, 1);
  const done = trials.filter((t) => t.status === "completed");
  assert.equal(done.length, 1);
  assert.ok(done[0].result && done[0].result.summary);
  assert.ok(activeTrial(trials));
  assert.ok(meds.length >= 2);
  const all = days.flatMap((d) => d.entries);
  for (const type of ["food", "sleep", "meds", "hydration", "period", "headache"]) {
    assert.ok(all.some((e) => e.type === type), `no ${type} entries`);
  }
  const headaches = all.filter((e) => e.type === "headache");
  assert.ok(headaches.length >= 6 && headaches.length <= 8);
  assert.ok(new Set(headaches.map((h) => h.severity)).size >= 4);
  assert.ok(all.some((e) => e.type === "food" && e.items.some((i) => i.tags.length)));
});

test("sample data is the same every time for the same date, and moves with the date", () => {
  assert.deepEqual(buildDemoData(TODAY), buildDemoData(TODAY));
  assert.equal(buildDemoData("2027-01-10").days.at(-1).date, "2027-01-10");
});

test("buildStats runs on the sample data and finds a clear factor", () => {
  const { days, meds } = buildDemoData(TODAY);
  const stats = buildStats(days, { today: TODAY, medNames: meds.map((m) => m.name) });
  assert.ok(stats.factors.length > 0);
  assert.ok(stats.factors.some((f) => f.confidence !== "early guess"));
  assert.ok(stats.factors.some((f) => f.key === "tag:aged_cheese"));
});

test("the pre-written Insight matches the schema, the safety check and the sample counts", () => {
  assert.deepEqual(Object.keys(DEMO_INSIGHT).sort(), [...Object.keys(INSIGHT_SCHEMA.properties), "medication_note"].sort());
  assert.deepEqual(validateInsight(DEMO_INSIGHT, { medNames: ["Ibuprofen", "Magnesium"] }), { ...DEMO_INSIGHT, medication_note: null });
  const { days, meds } = buildDemoData(TODAY);
  const stats = buildStats(days, { today: TODAY, medNames: meds.map((m) => m.name) });
  const sleep = stats.factors.find((f) => f.key === DEMO_INSIGHT.try_next.factor_key);
  assert.equal(sleep.confidence, DEMO_INSIGHT.try_next.confidence);
  assert.ok(DEMO_INSIGHT.try_next.why.includes(`${sleep.beforeHeadache} of your ${stats.attacks} headaches`));
  assert.ok(DEMO_INSIGHT.try_next.why.includes(`${sleep.controlHits} of ${sleep.controlTotal}`));
  const cheese = stats.factors.find((f) => f.key === "tag:aged_cheese");
  assert.ok(DEMO_INSIGHT.also_watching[0].evidence.includes(`${cheese.beforeHeadache} of ${cheese.headacheTotal} headaches`));
  assert.ok(DEMO_INSIGHT.also_watching[0].evidence.includes(`${cheese.controlHits} of ${cheese.controlTotal}`));
  assert.ok(DEMO_INSIGHT.cycle_note.startsWith(`${stats.cycle.nearPeriod} of your ${stats.cycle.counted} headaches`));
  assert.ok(DEMO_INSIGHT.medication_note.includes(`${stats.acuteMedDays30} of the last 30`));
});

test("entries added in the demo show up, and a new backend starts clean", async () => {
  const demo = createDemoBackend(TODAY);
  const before = (await demo.listDay(TODAY)).length;
  const id = await demo.add(TODAY, { type: "note", time: "20:00", text: "hello" });
  assert.ok(id);
  const day = await demo.listDay(TODAY);
  assert.equal(day.length, before + 1);
  assert.equal(day.find((e) => e.id === id).text, "hello");
  await demo.update(id, TODAY, { type: "note", time: "20:00", text: "changed" });
  assert.equal((await demo.listDay(TODAY)).find((e) => e.id === id).text, "changed");
  const all = await demo.listAll();
  assert.ok(all[0].date >= all.at(-1).date);
  await demo.remove(id);
  assert.equal((await demo.listDay(TODAY)).length, before);
  await demo.add(TODAY, { type: "note", time: "21:00", text: "kept" });
  assert.equal((await createDemoBackend(TODAY).listDay(TODAY)).length, before);
});

test("settings, meds, insight and trials behave like the real backend's return shapes", async () => {
  const demo = createDemoBackend(TODAY);
  const settings = await demo.getSettings();
  assert.ok(settings.password_set_at && settings.ai_notice_seen_at);
  await demo.saveSettings({ ai_notice_seen_at: "2026-01-01T00:00:00Z" });
  assert.equal((await demo.getSettings()).ai_notice_seen_at, "2026-01-01T00:00:00Z");
  assert.ok((await demo.getSettings()).password_set_at);

  const before = (await demo.listMeds()).length;
  await demo.addMed({ name: "Riboflavin", category: "supplement", default_dose: null });
  const meds = await demo.listMeds();
  assert.equal(meds.length, before + 1);
  assert.ok(meds.at(-1).id && meds.at(-1).created_at);
  await demo.removeMed(meds.at(-1).id);
  assert.equal((await demo.listMeds()).length, before);

  const saved = await demo.getInsight();
  assert.ok(saved.result.try_next && saved.created_at);
  await demo.saveInsight({ ...DEMO_INSIGHT, source: "rules" });
  assert.equal((await demo.getInsight()).result.source, "rules");

  const trials = await demo.listTrials();
  assert.equal(trials.length, 2);
  const stopped = await demo.saveTrial({ ...activeTrial(trials), status: "stopped", result: null });
  assert.equal(stopped.status, "stopped");
  assert.equal((await demo.listTrials()).length, 2);
  const fresh = await demo.saveTrial({ suggestion: { title: "x" }, start_date: TODAY, end_date: TODAY, status: "active", result: null });
  assert.ok(fresh.id && fresh.created_at);
  assert.equal((await demo.listTrials()).length, 3);
});

test("ai() makes no network call and returns pre-written data", async (t) => {
  t.mock.method(globalThis, "fetch", noFetch);
  const demo = createDemoBackend(TODAY);
  const split = await demo.ai("split_food", { text: "Coffee, aged cheddar and an apple" });
  assert.deepEqual(split.items.map((i) => i.name), ["Coffee", "aged cheddar", "apple"]);
  assert.deepEqual(split.items[1].tags, ["aged_cheese"]);
  assert.equal(validateItems(split.items).length, 3);
  assert.deepEqual(demoSplitFood("").items, []);
  const analysis = await demo.ai("analyze", { today: TODAY });
  assert.equal(analysis.source, "ai");
  assert.deepEqual(analysis.result, DEMO_INSIGHT);
  await assert.rejects(demo.ai("read_screenshot", {}), (e) => e.message === SCREENSHOTS_OFF && /demo/.test(e.message));
});

test("every method works with Supabase and fetch unreachable, and nothing is written to storage", async (t) => {
  t.mock.method(globalThis, "fetch", noFetch);
  const writes = [];
  globalThis.localStorage = { getItem: () => null, setItem: (...a) => writes.push(a), removeItem() {} };
  t.after(() => { delete globalThis.localStorage; setBackend(null); });
  setBackend(createDemoBackend(TODAY));
  assert.equal(isDemo(), true);
  const b = data();
  await b.listDay(TODAY); await b.listAll(); await b.add(TODAY, { type: "hydration", time: "10:00", amount: 8 });
  await b.update("nope", TODAY, { type: "note", time: "10:00" }); await b.remove("nope");
  await b.listMeds(); await b.addMed({ name: "A", category: "other", default_dose: null }); await b.removeMed("nope");
  await b.getSettings(); await b.saveSettings({}); await b.getInsight(); await b.saveInsight(DEMO_INSIGHT);
  await b.listTrials(); await b.saveTrial({ suggestion: {}, start_date: TODAY, end_date: TODAY, status: "active" });
  await b.ai("split_food", { text: "toast" });
  assert.deepEqual(writes, []);
  setBackend(createSupabaseBackend(throwingClient));
  assert.equal(isDemo(), false);
});

test("the only localStorage use in the app is skipped in demo mode", () => {
  const dir = new URL("../public/js/", import.meta.url);
  const source = readFileSync(new URL("insights.js", dir), "utf8");
  assert.match(source, /function loadKept\(\)\{\s*if\(isDemo\(\)\) return;/);
  assert.match(source, /keptIds\.add\(id\);\s*if\(isDemo\(\)\) return;/);
  for (const file of ["app", "auth", "forms", "food", "today", "history", "demo", "demo-data"]) {
    assert.doesNotMatch(readFileSync(new URL(`${file}.js`, dir), "utf8"), /localStorage|sessionStorage/, file);
  }
});
