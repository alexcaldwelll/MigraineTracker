import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/css/tokens.css", import.meta.url), "utf8");

function declarations(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
const darkStart = css.indexOf("prefers-color-scheme: dark");
assert.ok(darkStart > 0, "Low light block is missing");
const warm = declarations(css.slice(0, darkStart));
const themes = {
  "Warm paper": warm,
  "Low light": { ...warm, ...declarations(css.slice(darkStart)) },
};

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// [foreground token, background token] pairs the app actually renders as text.
const surfaces = ["paper", "card", "field"];
const pairs = [
  ...["ink", "ink-soft", "muted", "accent-dark", "warn-ink"].flatMap((fg) => surfaces.map((bg) => [fg, bg])),
  ["ink", "line"],
  ["accent-dark", "accent-tint"],
  ["warn-ink", "warn-tint"],
  ["ink", "warn-tint"],
  ["on-accent", "accent"],
  ["on-accent", "accent-dark"],
  ["paper", "accent-dark"],
  ["on-warn", "warn"],
  ["on-warn", "warn-hover"],
  ...["food", "headache", "prodrome", "meds", "sleep", "workout", "period", "hydration", "note"]
    .map((t) => ["on-tag", `tag-${t}`]),
];

for (const [name, tokens] of Object.entries(themes)) {
  test(`${name}: text and background pairs reach 4.5:1`, () => {
    for (const [fg, bg] of pairs) {
      assert.ok(tokens[fg] && tokens[bg], `missing token ${fg} or ${bg}`);
      const r = ratio(tokens[fg], tokens[bg]);
      assert.ok(r >= 4.5, `${name}: --${fg} ${tokens[fg]} on --${bg} ${tokens[bg]} is ${r.toFixed(2)}:1`);
    }
  });
}

test("Low light redefines every Warm paper color token", () => {
  const dark = declarations(css.slice(darkStart));
  for (const key of Object.keys(warm)) assert.ok(key in dark, `--${key} has no Low light value`);
});
