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

// Like Supabase, rejects a new password identical to the current one.
function fakeAccount(current) {
  const account = {
    updates: 0,
    async updateUser({ password }) {
      account.updates += 1;
      if (password === current) return { error: { message: "same_password" } };
      current = password;
      return { error: null };
    },
  };
  return account;
}

// saveSettings fails `failures` times, then succeeds.
function flakySettings(failures) {
  const saved = [];
  return {
    saved,
    getSettings: async () => null,
    async saveSettings(patch) {
      if (failures-- > 0) throw new Error("database down.");
      saved.push(patch);
    },
  };
}

async function pressSave($, password) {
  $("#newPassword").value = password;
  $("#confirmPassword").value = password;
  await $("#savePasswordBtn").click();
}

async function startAtPasswordScreen(t, backend, account) {
  const page = start(t, backend, { updateUser: account.updateUser });
  page.emit("SIGNED_IN", newSession());
  await tick();
  await tick();
  return page;
}

test("a password that cannot be recorded keeps the person out, and pressing Save again records it", async (t) => {
  const backend = flakySettings(1);
  const account = fakeAccount("temporary pass");
  const { $, entered } = await startAtPasswordScreen(t, backend, account);

  await pressSave($, "long enough now");
  assert.equal(entered.length, 0);
  assert.match($("#passwordStatus").textContent, /could not record it/);

  await pressSave($, "long enough now");
  assert.equal(account.updates, 1);
  assert.equal(backend.saved.length, 1);
  assert.deepEqual(Object.keys(backend.saved[0]), ["password_set_at"]);
  assert.equal(entered.length, 1);
});

test("re-entering the temporary password is refused and records nothing", async (t) => {
  const backend = flakySettings(0);
  const account = fakeAccount("temporary pass");
  const { $, entered } = await startAtPasswordScreen(t, backend, account);

  await pressSave($, "temporary pass");
  assert.equal(backend.saved.length, 0);
  assert.equal(entered.length, 0);
  assert.match($("#passwordStatus").textContent, /same_password/);
});

test("a different password on the retry goes through updateUser", async (t) => {
  const backend = flakySettings(1);
  const account = fakeAccount("temporary pass");
  const { $, entered } = await startAtPasswordScreen(t, backend, account);

  await pressSave($, "long enough now");
  await pressSave($, "another long one");
  assert.equal(account.updates, 2);
  assert.equal(backend.saved.length, 1);
  assert.equal(entered.length, 1);
});

test("a sign-out forgets the unrecorded password, so the next person cannot skip updateUser", async (t) => {
  const backend = flakySettings(1);
  const account = fakeAccount("temporary pass");
  const { $, emit, entered } = await startAtPasswordScreen(t, backend, account);

  await pressSave($, "long enough now");
  emit("SIGNED_OUT", null);
  emit("SIGNED_IN", newSession());
  await tick();
  await tick();

  await pressSave($, "long enough now");
  assert.equal(account.updates, 2);
  assert.equal(backend.saved.length, 0);
  assert.equal(entered.length, 0);
});

test("the next person is not trusted either when no sign-out event came first", async (t) => {
  const backend = flakySettings(1);
  const account = fakeAccount("temporary pass");
  const { $, emit, entered } = await startAtPasswordScreen(t, backend, account);

  await pressSave($, "long enough now");
  emit("SIGNED_IN", newSession());
  await tick();
  await tick();

  await pressSave($, "long enough now");
  assert.equal(account.updates, 2);
  assert.equal(backend.saved.length, 0);
  assert.equal(entered.length, 0);
});

test("with no Supabase library, sign-in says so and the demo still opens", async (t) => {
  const $ = fakePage();
  t.after(() => { delete globalThis.document; });
  globalThis.document.body = { classList: { add() {} } };
  const entered = [];
  initAuth(null, () => entered.push(true));
  assert.equal($("#authScreen").style.display, "block");
  assert.match($("#authStatus").textContent, /could not load/i);
  assert.equal($("#authSignInBtn").disabled, true);
  $("#demoBtn").click();
  assert.equal(entered.length, 1);
  assert.equal($("#app").style.display, "block");
});

function startWithAddress(t, search) {
  const $ = fakePage();
  t.after(() => { delete globalThis.document; });
  globalThis.document.body = { classList: { add() {} } };
  let listening = false;
  const entered = [];
  const client = { auth: { onAuthStateChange() { listening = true; } } };
  initAuth(client, () => entered.push(true), search);
  return { $, entered, listening: () => listening };
}

test("a ?demo address opens the demo with no sign-in screen", (t) => {
  const { $, entered, listening } = startWithAddress(t, "?demo");
  assert.equal(entered.length, 1);
  assert.equal($("#app").style.display, "block");
  assert.equal($("#authScreen").style.display, "none");
  assert.equal($("#demoBanner").hidden, false);
  assert.equal(listening(), false, "the demo never touches a signed-in session");
});

test("any other address still waits for sign-in", (t) => {
  const { entered, listening } = startWithAddress(t, "?utm=github");
  assert.equal(entered.length, 0);
  assert.equal(listening(), true);
});
