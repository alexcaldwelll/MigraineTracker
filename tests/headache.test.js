import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findOpenHeadache, startHeadache, endHeadache, isStale, headacheDates, isHeadacheEntry, closedHeadacheTimes, daysWithHeadacheDates, headacheDaySet,
} from "../public/js/headache.js";

const at = (s) => new Date(s); // local time, no zone suffix
const open = { id: "h1", type: "headache", open: true, date: "2026-11-02", time: "22:00", start_at: at("2026-11-02T22:00:00").toISOString() };
const days = (...entries) => [{ date: "2026-11-02", entries }];

test("a second startHeadache while one is open returns null", () => {
  assert.equal(startHeadache(days(open), at("2026-11-03T08:00:00")), null);
});

test("startHeadache returns an open entry with date, time and start_at", () => {
  const now = at("2026-11-03T08:05:00");
  const e = startHeadache([], now);
  assert.equal(e.type, "headache");
  assert.equal(e.open, true);
  assert.equal(e.date, "2026-11-03");
  assert.equal(e.time, "08:05");
  assert.equal(e.start_at, now.toISOString());
});

test("findOpenHeadache finds an open one on an earlier day and carries its date", () => {
  const found = findOpenHeadache([{ date: "2026-11-03", entries: [] }, { date: "2026-11-02", entries: [{ ...open, date: undefined }] }]);
  assert.equal(found.id, "h1");
  assert.equal(found.date, "2026-11-02");
});

test("old entries with a blank duration and no open field are not open", () => {
  const old = { id: "o", type: "headache", time: "09:00", severity: 5, duration: null };
  assert.equal(findOpenHeadache(days(old)), null);
  assert.equal(findOpenHeadache(days({ ...old, duration: "" })), null);
  assert.notEqual(startHeadache(days(old), at("2026-11-02T10:00:00")), null);
});

test("isStale is false at 23h59m and true at 24h", () => {
  assert.equal(isStale(open, at("2026-11-03T21:59:00")), false);
  assert.equal(isStale(open, at("2026-11-03T22:00:00")), true);
});

test("isStale falls back to date and time and ignores closed entries", () => {
  const noStart = { type: "headache", open: true, date: "2026-11-02", time: "22:00" };
  assert.equal(isStale(noStart, at("2026-11-03T22:00:00")), true);
  assert.equal(isStale({ ...open, open: false }, at("2026-11-09T22:00:00")), false);
});

test("endHeadache closes the entry and records hours and end_at", () => {
  const ended = endHeadache(open, at("2026-11-03T02:00:00"));
  assert.equal(ended.open, false);
  assert.equal(ended.duration, 4);
  assert.equal(ended.end_at, at("2026-11-03T02:00:00").toISOString());
  assert.equal(open.open, true, "input is not mutated");
});

test("a headache from 22:00 Monday to 02:00 Tuesday gives both dates", () => {
  const ended = endHeadache({ ...open, date: "2026-11-02" }, at("2026-11-03T02:00:00"));
  assert.deepEqual(headacheDates(ended), ["2026-11-02", "2026-11-03"]);
});

test("a long closed headache gives every date it touches", () => {
  const e = endHeadache(open, at("2026-11-05T01:00:00"));
  assert.deepEqual(headacheDates(e), ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
});

test("an open headache gives only its start date", () => {
  assert.deepEqual(headacheDates(open), ["2026-11-02"]);
});

test("an old entry without end_at gives its date, whatever its duration", () => {
  assert.deepEqual(headacheDates({ type: "headache", date: "2026-10-01", time: "23:00", duration: "6" }), ["2026-10-01"]);
});

test("a headache with severity: null still counts", () => {
  assert.equal(isHeadacheEntry({ type: "headache", severity: null }), true);
  assert.equal(isHeadacheEntry({ type: "food" }), false);
  assert.equal(isHeadacheEntry(null), false);
});

test("closedHeadacheTimes gives start_at, and end_at only when a duration is given", () => {
  const t = closedHeadacheTimes("2026-11-02", "22:00", "4");
  assert.equal(t.start_at, at("2026-11-02T22:00:00").toISOString());
  assert.equal(t.end_at, at("2026-11-03T02:00:00").toISOString());
  assert.equal(closedHeadacheTimes("2026-11-02", "22:00", null).end_at, undefined);
});

test("a midnight-crossing headache makes an empty day for a date with no entries", () => {
  const ended = endHeadache(open, at("2026-11-03T02:00:00"));
  const input = [{ date: "2026-11-02", entries: [ended] }];
  assert.deepEqual([...headacheDaySet(input)], ["2026-11-02", "2026-11-03"]);
  assert.deepEqual(daysWithHeadacheDates(input), [...input, { date: "2026-11-03", entries: [] }]);
  const covered = [...input, { date: "2026-11-03", entries: [{ type: "food" }] }];
  assert.equal(daysWithHeadacheDates(covered).length, 2, "no duplicate for a day already present");
});

test("insights counts headache days through isHeadacheEntry, not severity", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../public/js/insights.js", import.meta.url), "utf8");
  assert.match(src, /daysWithHeadacheDates/);
  assert.doesNotMatch(src, /severity\s*!=\s*null/);
});

test("headache.js imports nothing from DOM modules", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../public/js/headache.js", import.meta.url), "utf8");
  const imports = [...src.matchAll(/from\s+'\.\/([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["dates.js"]);
});
