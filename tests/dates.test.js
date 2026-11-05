import { test } from "node:test";
import assert from "node:assert/strict";
import { dayTitle, localDate, shiftDate, shortDate } from "../public/js/dates.js";

function inZone(t, zone) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => { process.env.TZ = previous; });
}

test("localDate at 23:30 local keeps the local date, unlike toISOString", (t) => {
  inZone(t, "America/Los_Angeles");
  const lateEvening = new Date(2026, 10, 4, 23, 30);
  assert.equal(lateEvening.toISOString().slice(0, 10), "2026-11-05");
  assert.equal(localDate(lateEvening), "2026-11-04");
});

test("localDate defaults to now", () => {
  const before = localDate();
  assert.match(before, /^\d{4}-\d{2}-\d{2}$/);
});

test("localDate zero-pads month and day", () => {
  assert.equal(localDate(new Date(2026, 0, 5, 12)), "2026-01-05");
});

test("shiftDate moves whole local days east of UTC, where local midnight is the day before in UTC", (t) => {
  inZone(t, "Asia/Tokyo");
  assert.equal(shiftDate("2026-11-04", 1), "2026-11-05");
  assert.equal(shiftDate("2026-11-04", -1), "2026-11-03");
});

test("shiftDate moves whole local days west of UTC and across a daylight saving change", (t) => {
  inZone(t, "America/Los_Angeles");
  assert.equal(shiftDate("2026-03-07", 1), "2026-03-08");
  assert.equal(shiftDate("2026-03-08", 1), "2026-03-09");
  assert.equal(shiftDate("2026-11-01", 1), "2026-11-02");
});

test("shiftDate crosses month and year ends", (t) => {
  inZone(t, "Asia/Tokyo");
  assert.equal(shiftDate("2026-11-30", 1), "2026-12-01");
  assert.equal(shiftDate("2027-01-01", -1), "2026-12-31");
});

test("shortDate reads like the Today header", () => {
  assert.equal(shortDate("2026-11-04"), "Wed, Nov 4");
});

test("dayTitle names the days near today, then the weekday", () => {
  assert.equal(dayTitle("2026-11-04", "2026-11-04"), "Today");
  assert.equal(dayTitle("2026-11-03", "2026-11-04"), "Yesterday");
  assert.equal(dayTitle("2026-11-05", "2026-11-04"), "Tomorrow");
  assert.equal(dayTitle("2026-11-01", "2026-11-04"), "Sunday");
});
