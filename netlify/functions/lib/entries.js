import { SUPABASE_URL, supabaseHeaders } from "./config.js";

const PAGE_SIZE = 1000;

// Rows as days, in the shape the browser's data layer gives patterns.js.
export function groupByDate(rows) {
  const days = new Map();
  for (const { date, time, type, data } of rows) {
    if (!days.has(date)) days.set(date, []);
    days.get(date).push({ type, time, ...data });
  }
  return [...days].map(([date, entries]) => ({ date, entries }));
}

// The signed-in user's saved medications. Throws on failure, so the check on AI
// text never runs against a partial list.
export async function loadMeds(token) {
  const query = new URLSearchParams({ select: "name" });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/meds_catalog?${query}`, {
    headers: supabaseHeaders(token),
  });
  if (!res.ok) throw new Error("Could not load meds");
  return res.json();
}

// Loads the signed-in user's entries, oldest first. Row-level security limits
// the rows to their own. Sorting ends on id so pages cannot overlap or skip.
export async function loadEntries(token) {
  const entries = [];
  for (;;) {
    const query = new URLSearchParams({
      select: "date,time,type,data",
      order: "date.asc,time.asc,id.asc",
      limit: String(PAGE_SIZE),
      offset: String(entries.length),
    });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/entries?${query}`, {
      headers: supabaseHeaders(token),
    });
    if (!res.ok) throw new Error("Could not load entries");
    const page = await res.json();
    entries.push(...page);
    if (page.length < PAGE_SIZE) return entries;
  }
}
