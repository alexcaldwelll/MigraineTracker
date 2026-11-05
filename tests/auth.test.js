import { test } from "node:test";
import assert from "node:assert/strict";
import { initAuth } from "../public/js/auth.js";
import { setBackend } from "../public/js/data.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Elements are created on first use, which is all auth.js needs from a page.
function fakePage() {
  const elements = new Map();
  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        const listeners = {};
        elements.set(selector, {
          style: {},
          value: "",
          textContent: "",
          addEventListener: (type, fn) => { listeners[type] = fn; },
          click: () => listeners.click(),
        });
      }
      return elements.get(selector);
    },
  };
  return globalThis.document.querySelector;
}

function start(t, backend, clientAuth = {}) {
  const $ = fakePage();
  t.after(() => { delete globalThis.document; });
  t.mock.method(console, "error", () => {});
  setBackend(backend);
  let emit;
  const entered = [];
  const client = { auth: { onAuthStateChange(fn) { emit = fn; }, ...clientAuth } };
  initAuth(client, () => entered.push(true));
  return { $, emit, entered };
}

let nextUser = 0;
const newSession = () => ({ user: { id: `user-${++nextUser}` } });

test("the gate waits a turn before calling Supabase", async (t) => {
  let reads = 0;
  const { emit } = start(t, { getSettings: async () => { reads += 1; return { password_set_at: "x" }; } });
  emit("INITIAL_SESSION", newSession());
  assert.equal(reads, 0);
  await tick();
  assert.equal(reads, 1);
});

test("someone who has set a password enters the app", async (t) => {
  const { $, emit, entered } = start(t, { getSettings: async () => ({ password_set_at: "x" }) });
  emit("SIGNED_IN", newSession());
  await tick();
  await tick();
  assert.equal($("#app").style.display, "block");
  assert.equal(entered.length, 1);
});

test("someone with no settings row must choose a password", async (t) => {
  const { $, emit, entered } = start(t, { getSettings: async () => null });
  emit("SIGNED_IN", newSession());
  await tick();
  await tick();
  assert.equal($("#passwordScreen").style.display, "block");
  assert.equal($("#passwordForm").style.display, "block");
  assert.equal($("#app").style.display, "none");
  assert.equal(entered.length, 0);
});

test("the gate fails closed when settings cannot be read, and Try again re-checks", async (t) => {
  let healthy = false;
  const backend = {
    async getSettings() {
      if (!healthy) throw new Error("database down.");
      return { password_set_at: "x" };
    },
  };
  const { $, emit, entered } = start(t, backend);
  emit("SIGNED_IN", newSession());
  await tick();
  await tick();
  assert.equal($("#app").style.display, "none");
  assert.equal(entered.length, 0);
  assert.equal($("#gateRetry").style.display, "block");
  assert.match($("#passwordStatus").textContent, /database down/);

  healthy = true;
  await $("#gateRetryBtn").click();
  assert.equal(entered.length, 1);
});

test("repeat events for the same person run the gate once; a sign-out resets that", async (t) => {
  let reads = 0;
  const { emit } = start(t, { getSettings: async () => { reads += 1; return { password_set_at: "x" }; } });
  const session = newSession();
  emit("INITIAL_SESSION", session);
  emit("SIGNED_IN", session);
  await tick();
  emit("SIGNED_IN", session);
  emit("TOKEN_REFRESHED", session);
  await tick();
  assert.equal(reads, 1);

  emit("SIGNED_OUT", null);
  emit("SIGNED_IN", session);
  await tick();
  assert.equal(reads, 2);
});

test("a gate check overtaken by a sign-out does not let anyone in", async (t) => {
  let finishRead;
  const read = new Promise((resolve) => { finishRead = resolve; });
  const { $, emit, entered } = start(t, { getSettings: () => read });
  emit("SIGNED_IN", newSession());
  await tick();
  emit("SIGNED_OUT", null);
  finishRead({ password_set_at: "x" });
  await tick();
  assert.equal(entered.length, 0);
  assert.equal($("#authScreen").style.display, "block");
});

test("saving a new password records it through saveSettings, then enters", async (t) => {
  const saved = [];
  const { $, emit, entered } = start(
    t,
    { getSettings: async () => null, saveSettings: async (patch) => { saved.push(patch); } },
    { updateUser: async () => ({ error: null }) },
  );
  emit("SIGNED_IN", newSession());
  await tick();
  await tick();
  $("#newPassword").value = "long enough now";
  $("#confirmPassword").value = "long enough now";
  await $("#savePasswordBtn").click();
  assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0]), ["password_set_at"]);
  assert.equal(entered.length, 1);
});

test("a password that cannot be recorded keeps the person out and says so", async (t) => {
  const { $, emit, entered } = start(
    t,
    { getSettings: async () => null, saveSettings: async () => { throw new Error("database down."); } },
    { updateUser: async () => ({ error: null }) },
  );
  emit("SIGNED_IN", newSession());
  await tick();
  await tick();
  $("#newPassword").value = "long enough now";
  $("#confirmPassword").value = "long enough now";
  await $("#savePasswordBtn").click();
  assert.equal(entered.length, 0);
  assert.match($("#passwordStatus").textContent, /could not record it/);
});
