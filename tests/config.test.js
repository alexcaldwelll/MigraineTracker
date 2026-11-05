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
  assert.deepEqual(directive("script-src").split(/\s+/).slice(1), ["'self'", "https://cdn.jsdelivr.net/npm/@supabase/"]);
  // Inline style attributes remain in the markup.
  assert.match(directive("style-src"), /'unsafe-inline'/);
});

test("public/index.html exists and pins supabase-js to one checked file", () => {
  const url = new URL("../public/index.html", import.meta.url);
  assert.ok(existsSync(url), "public/index.html is missing");
  const html = readFileSync(url, "utf8");
  const tag = html.match(/<script[^>]*supabase-js[^>]*>/)[0];
  // The exact file, because jsDelivr rewrites the short URL and warns against SRI on it.
  assert.match(tag, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.\d+\.\d+\/dist\/umd\/supabase\.js"/);
  assert.match(tag, /integrity="sha384-[A-Za-z0-9+/]{64}"/);
  assert.match(tag, /crossorigin="anonymous"/);
});

test("Netlify builds with the Node version the README asks for", () => {
  assert.match(toml, /\[build\.environment\]\s+NODE_VERSION = "24"/);
});

test("the food field stops at the server's 2,000 character limit", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html.match(/<input[^>]*id="foodText"[^>]*>/)[0], /maxlength="2000"/);
});
