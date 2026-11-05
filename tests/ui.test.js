import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../public/js/ui.js";

test("escapeHtml leaves no tag behind", () => {
  const out = escapeHtml("<img src=x>");
  assert.equal(out.includes("<"), false);
  assert.equal(out, "&lt;img src=x&gt;");
});

test("escapeHtml escapes ampersands first, so entities are not double-decoded", () => {
  assert.equal(escapeHtml("a & b &lt;"), "a &amp; b &amp;lt;");
});

test("escapeHtml makes text safe inside a quoted attribute", () => {
  const out = escapeHtml(`5" tablet's`);
  assert.equal(out.includes('"'), false);
  assert.equal(out.includes("'"), false);
});

test("escapeHtml treats missing values as empty and stringifies numbers", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(0), "0");
});
