import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const jsDir = new URL("../public/js/", import.meta.url);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const files = readdirSync(jsDir).filter((f) => f.endsWith(".js"));
const sources = Object.fromEntries(files.map((f) => [f, readFileSync(new URL(f, jsDir), "utf8")]));
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test("every planned module exists", () => {
  for (const name of ["app", "auth", "data", "today", "forms", "history", "insights", "ui", "dates"]) {
    assert.ok(files.includes(`${name}.js`), `${name}.js is missing`);
  }
});

test("every module but app.js imports in Node with no DOM or window", async () => {
  assert.equal(typeof document, "undefined");
  assert.equal(typeof window, "undefined");
  for (const file of files.filter((f) => f !== "app.js")) {
    await import(new URL(file, jsDir).href);
  }
});

test("every named import in every module is exported by its target", async () => {
  let checked = 0;
  for (const [file, source] of Object.entries(sources)) {
    for (const [, names, target] of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/g)) {
      const exported = await import(new URL(target, jsDir).href);
      for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) {
        assert.ok(name in exported, `${file} imports ${name} from ${target}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 20, `only ${checked} imports found`);
});

test("every id selector used in public/js exists in index.html", () => {
  // Any string that starts a selector with #id. href="#icon-..." and colors are not selectors.
  const selector = /(?<![=\w])['"`]#(?![0-9a-f]{6}['"`])([A-Za-z][\w-]*)/gi;
  const found = new Set();
  for (const [file, source] of Object.entries(sources)) {
    for (const [, id] of source.matchAll(selector)) {
      found.add(id);
      const present = id.endsWith("-")
        ? [...htmlIds].some((known) => known.startsWith(id)) // '#fields-'+type
        : htmlIds.has(id);
      assert.ok(present, `${file} selects #${id}, which index.html does not have`);
    }
  }
  assert.ok(found.size > 60, `only ${found.size} selectors found, so the pattern has likely stopped matching`);
});

test("the ids built at runtime exist for every type chip and tab", () => {
  const types = [...html.matchAll(/class="type-chip[^"]*" data-val="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(types.length, 9);
  for (const type of types) assert.ok(htmlIds.has(`fields-${type}`), `#fields-${type} is missing`);
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(tabs.length, 3);
  for (const tab of tabs) assert.ok(htmlIds.has(`tab-${tab}`), `#tab-${tab} is missing`);
});

test("index.html loads app.js as its only module and has no inline script or style", () => {
  assert.equal([...html.matchAll(/<script\b(?![^>]*\bsrc=)/g)].length, 0);
  assert.equal([...html.matchAll(/<script[^>]*type="module"[^>]*>/g)].length, 1);
  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/);
  assert.equal(/<style\b/.test(html), false);
  for (const sheet of ["tokens", "base", "components"]) {
    assert.match(html, new RegExp(`<link rel="stylesheet" href="css/${sheet}\\.css">`));
  }
});

test("no markup, static or generated, carries an inline event handler", () => {
  const handler = /<[^>]*\son[a-z]+\s*=/i;
  assert.equal(handler.test(html), false);
  for (const [file, source] of Object.entries(sources)) {
    assert.equal(handler.test(source), false, file);
  }
});

test("only data.js and auth.js receive the Supabase client, and only app.js creates it", () => {
  for (const [file, source] of Object.entries(sources)) {
    if (file !== "app.js") assert.equal(source.includes("createClient"), false, file);
    if (!["app.js", "auth.js", "data.js"].includes(file)) {
      assert.equal(/\bclient\b/.test(source), false, file);
    }
    if (file !== "data.js") assert.equal(/\.from\(\s*["']/.test(source), false, file);
  }
});
