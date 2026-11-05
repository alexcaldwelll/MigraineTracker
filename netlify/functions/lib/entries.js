import { SUPABASE_URL, supabaseHeaders } from "./config.js";

const PAGE_SIZE = 1000;

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
