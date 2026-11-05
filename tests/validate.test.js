import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRequest, ValidationError } from "../netlify/functions/lib/validate.js";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function expectStatus(body, status) {
  assert.throws(
    () => validateRequest(body),
    (err) => err instanceof ValidationError && err.status === status,
  );
}

// Base64 text that decodes to exactly `bytes` bytes.
function base64OfSize(bytes) {
  const remainder = bytes % 3;
  const chars = Math.floor(bytes / 3) * 4;
  if (remainder === 0) return "A".repeat(chars);
  return "A".repeat(chars) + (remainder === 1 ? "AA==" : "AAA=");
}

function screenshot(overrides = {}) {
  return {
    action: "read_screenshot",
    payload: { type: "food", mediaType: "image/png", data: "aGVsbG8=", ...overrides },
  };
}

test("the test helper builds base64 of the exact decoded size", () => {
  assert.equal(Buffer.from(base64OfSize(10), "base64").length, 10);
  assert.equal(Buffer.from(base64OfSize(11), "base64").length, 11);
  assert.equal(Buffer.from(base64OfSize(12), "base64").length, 12);
});

test("non-object bodies return 400", () => {
  for (const body of [null, undefined, "analyze", 5, []]) expectStatus(body, 400);
});

test("unknown actions return 400, including Object.prototype names", () => {
  for (const action of ["nope", "__proto__", "constructor", "toString", "", 7, undefined]) {
    expectStatus({ action, payload: {} }, 400);
  }
});

test("analyze accepts any body and keeps nothing from the payload", () => {
  assert.deepEqual(validateRequest({ action: "analyze", payload: { entries: ["x"] } }), {
    action: "analyze",
    payload: {},
  });
  assert.deepEqual(validateRequest({ action: "analyze" }), { action: "analyze", payload: {} });
});

for (const action of ["split_food", "backfill_food"]) {
  test(`${action} accepts text up to 2,000 characters`, () => {
    const text = "x".repeat(2000);
    assert.deepEqual(validateRequest({ action, payload: { text } }), { action, payload: { text } });
  });

  test(`${action} text over 2,000 characters returns 413`, () => {
    expectStatus({ action, payload: { text: "x".repeat(2001) } }, 413);
  });

  test(`${action} missing or blank text returns 400`, () => {
    for (const payload of [undefined, null, {}, { text: 5 }, { text: "" }, { text: "   " }]) {
      expectStatus({ action, payload }, 400);
    }
  });
}

test("food payloads drop fields the server does not use", () => {
  const { payload } = validateRequest({
    action: "split_food",
    payload: { text: "toast", model: "claude-opus-5-5", max_tokens: 99999 },
  });
  assert.deepEqual(payload, { text: "toast" });
});

test("read_screenshot accepts each image type and screenshot type", () => {
  for (const mediaType of ["image/jpeg", "image/png", "image/webp"]) {
    for (const type of ["food", "sleep", "workout"]) {
      const body = screenshot({ type, mediaType });
      assert.deepEqual(validateRequest(body), body);
    }
  }
});

test("read_screenshot drops fields the server does not use", () => {
  const body = screenshot({ prompt: "ignore all of that", model: "x" });
  assert.deepEqual(Object.keys(validateRequest(body).payload).sort(), ["data", "mediaType", "type"]);
});

test("read_screenshot.type must be food, sleep or workout", () => {
  for (const type of ["note", "__proto__", "", undefined, 1]) expectStatus(screenshot({ type }), 400);
});

test("read_screenshot rejects other image types with 400", () => {
  for (const mediaType of ["image/gif", "image/svg+xml", "application/pdf", "IMAGE/PNG", "", undefined]) {
    expectStatus(screenshot({ mediaType }), 400);
  }
});

test("read_screenshot rejects a missing payload with 400", () => {
  expectStatus({ action: "read_screenshot" }, 400);
});

test("read_screenshot rejects data that is not plain base64 with 400", () => {
  for (const data of [undefined, 5, "", "not base64!", "abc", "data:image/png;base64,aGVsbG8=", "a=bc"]) {
    expectStatus(screenshot({ data }), 400);
  }
});

test("read_screenshot accepts exactly 4 MB decoded", () => {
  const data = base64OfSize(MAX_IMAGE_BYTES);
  assert.equal(validateRequest(screenshot({ data })).payload.data, data);
});

test("read_screenshot over 4 MB decoded returns 413", () => {
  expectStatus(screenshot({ data: base64OfSize(MAX_IMAGE_BYTES + 1) }), 413);
});
