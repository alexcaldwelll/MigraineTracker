import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");

test("netlify.toml publishes only public/ and bundles functions with esbuild", () => {
  assert.match(toml, /publish = "public"/);
  assert.match(toml, /functions = "netlify\/functions"/);
  assert.match(toml, /node_bundler = "esbuild"/);
});

test("netlify.toml sets security headers", () => {
  assert.match(toml, /Content-Security-Policy/);
  assert.match(toml, /X-Content-Type-Options/);
});

test("the Content-Security-Policy allows no inline scripts", () => {
  const csp = toml.match(/Content-Security-Policy = "([^"]+)"/)[1];
  const directive = (name) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  assert.equal(directive("script-src").includes("'unsafe-inline'"), false);
  assert.match(directive("script-src"), /'self'/);
  assert.match(directive("script-src"), /https:\/\/cdn\.jsdelivr\.net/);
  // Inline style attributes remain in the markup.
  assert.match(directive("style-src"), /'unsafe-inline'/);
});

test("public/index.html exists and pins supabase-js", () => {
  const url = new URL("../public/index.html", import.meta.url);
  assert.ok(existsSync(url), "public/index.html is missing");
  const html = readFileSync(url, "utf8");
  assert.match(html, /@supabase\/supabase-js@2\.\d+\.\d+["']/);
});
