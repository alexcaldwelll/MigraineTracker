# Migraine Tracker Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Secure the app, then rebuild it as a simple tile-based tracker with split food logging, always-actionable Insights, tracked trials and a public sample-data demo.

**Architecture:** A static site in `public/` built from native ES modules, with no front-end build step. One authenticated Netlify function, `ai.js`, owns every prompt and model choice. Supabase stores data under row-level security. Pure logic modules such as `patterns.js` are unit tested and shared with the function.

**Tech Stack:** HTML, CSS, JavaScript ES modules; Supabase (Auth, Postgres, RLS); Netlify Functions on Node 24; `@anthropic-ai/sdk`; `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-04-migraine-tracker-redesign-design.md`

## Global Constraints

- Work on branch `redesign`. Merge to `main` only with the owner's approval.
- Node comes from nvm and may not be on PATH: `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"`.
- Run all tests with `npm test`, which runs `node --test tests/`.
- The package uses `"type": "module"`. `@anthropic-ai/sdk` is the only runtime dependency. Any front-end package or build step is out of scope.
- Models: `claude-sonnet-5-5` for `analyze` and `read_screenshot`, `claude-haiku-5-5` for `split_food` and `backfill_food`. Use only exact IDs.
- Daily limits per user: `split_food` 40, `analyze` 5, `read_screenshot` 10, `backfill_food` 100.
- The browser never sends a prompt, model or token limit.
- Never suggest starting, stopping or changing medication. Never suggest removing a whole macronutrient.
- All user and AI text is rendered through `textContent` or `escapeHtml`.
- Food amounts always display with "~". AI output never overwrites an item with `edited: true`.
- No logged entry may be lost because of an AI or network failure.
- Every commit ends with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Each phase leaves the live app working. **HANDOFF** steps need the owner, because the builder has no Supabase, Netlify, Anthropic or GitHub dashboard access. Deploying and pushing need the owner's go-ahead each time.

## Review Focus

1. A double-tap on "I have a headache", which is likely mid-migraine, must create exactly one open headache. Pinned in Task 9.
2. A failed save on a bad connection must keep what the person entered and show a retry, rather than clearing the form. Pinned in Task 8.
3. Someone with no headaches or only a few days of data must still get a useful suggestion. Pinned in Task 13.
4. Old entries with a blank `time`, or logged around midnight, must not crash `patterns.js` or fall outside the 48-hour windows. Pinned in Task 13.
5. An AI response that mentions changing medication, or contains HTML, must never reach the screen as advice or markup. Pinned in Task 14.

---

## Phase 1: Security

Ships on its own first. The open function may be live today.

### Task 1: Project layout and hosting lockdown

**Files:**
- Move: `index.html` to `public/index.html`, `schema.sql` to `supabase/schema.sql`
- Create: `package.json`, `tests/config.test.js`
- Modify: `netlify.toml`
- Remove from git only: `.claude/`, `.agents/`, `skills-lock.json` (add to `.gitignore`)

**Interfaces:**
- Produces: the `public/` publish directory and `npm test`.

- [ ] **Step 1: Commit the owner's existing work.** Create branch `redesign`. Commit the uncommitted `index.html` header changes alone, as `chore: keep header layout changes`.
- [ ] **Step 2: Write the failing test.** `tests/config.test.js` reads `netlify.toml` and asserts: it contains `publish = "public"`, `functions = "netlify/functions"`, `node_bundler = "esbuild"`, a `Content-Security-Policy` header and `X-Content-Type-Options`; `public/index.html` exists; and the Supabase script URL in it is pinned as `@supabase/supabase-js@2.<minor>.<patch>`.
- [ ] **Step 3: Run it.** Run `npm test`. Expected: FAIL.
- [ ] **Step 4: Implement.** Do the moves, keeping git history with `git mv`. Add `package.json` (`"type": "module"`, `"test": "node --test tests/"`, the Anthropic SDK dependency). Pin Supabase to the newest 2.x version from `npm view @supabase/supabase-js versions` that is at least two weeks old.

Headers for `/*`:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' https://piiahxbeqsrzagjximoh.supabase.co; img-src 'self' data: blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

`'unsafe-inline'` for scripts is temporary and is removed in Task 6.

- [ ] **Step 5: Verify.** Run `npm test`. Expected: PASS.
- [ ] **Step 6: Commit.** `chore: publish only public files and add security headers`

### Task 2: Usage limits and user settings in Supabase

**Files:**
- Modify: `supabase/schema.sql`
- Test: `tests/schema.test.js`

**Interfaces:**
- Produces:
  - `consume_ai_quota(p_action text) returns boolean`
  - table `user_settings(user_id uuid primary key default auth.uid(), ai_notice_seen_at timestamptz, password_set_at timestamptz)`

- [ ] **Step 1: Write the failing test.** `tests/schema.test.js` reads the SQL and asserts: the `ai_usage` table has row-level security on and no `create policy` for it; `consume_ai_quota` is `security definer` with `set search_path`; `execute` is revoked from `public` and `anon` and granted to `authenticated`; the four actions and limits appear; every statement is safe to re-run (`if not exists`, `create or replace`, `drop policy if exists`).
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.** `ai_usage(user_id, day date, action text, count int)` has primary key `(user_id, day, action)`. The function uses `auth.uid()`, never a passed-in user. It increments with `insert ... on conflict do update ... where count < limit` so it stays atomic under concurrent calls, and returns whether a row changed. Unknown actions return false. `user_settings` has an own-row policy like `entries`.
- [ ] **Step 4: Verify.** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: add per-user AI limits and user settings`

### Task 3: Protected AI function

**Files:**
- Create: `netlify/functions/ai.js`, `netlify/functions/lib/{config,auth,quota,validate,prompts,anthropic,entries}.js`
- Delete: `netlify/functions/analyze.js`
- Modify: `public/index.html`
- Test: `tests/ai-handler.test.js`, `tests/validate.test.js`, `tests/anthropic.test.js`

**Interfaces:**
- Consumes: `consume_ai_quota` from Task 2.
- Produces:
  - `POST /.netlify/functions/ai`, body `{ action, payload }`, header `Authorization: Bearer <token>`
  - `createHandler({ getUser, consumeQuota, handlers }) -> (req) => Promise<Response>`
  - `getUser(token) -> Promise<{id}|null>`, `consumeQuota(token, action) -> Promise<boolean>`
  - `validateRequest(body) -> {action, payload}`, which throws `ValidationError` with `status`
  - `callClaude({model, effort, maxTokens, system, content, schema}) -> Promise<object>`, which throws `AiUnavailable`
  - `loadEntries(token) -> Promise<Entry[]>`, which pages through all rows
  - browser `aiRequest(action, payload) -> Promise<object>`

- [ ] **Step 1: Write the failing handler tests**, using fake dependencies:

```js
test('no token returns 401 and never calls quota', ...)
test('invalid token returns 401', ...)
test('non-POST returns 405', ...)
test('unknown action returns 400', ...)
test('model, prompt and max_tokens in the body are ignored', ...)
test('over the limit returns 429 and never calls the handler', ...)
test('invalid payload returns 400 and does not use quota', ...)
test('AiUnavailable returns 502 with a generic message', ...)
test('error bodies never contain the API key or stack traces', ...)
```

- [ ] **Step 2: Write the failing validation tests.** Food text over 2,000 characters returns 413. Screenshots must be `image/jpeg`, `image/png` or `image/webp`, and data over 4 MB decoded returns 413. `read_screenshot.type` must be `food`, `sleep` or `workout`.
- [ ] **Step 3: Write the failing `callClaude` tests.** With a fake SDK client: `stop_reason: "refusal"` and `max_tokens` throw `AiUnavailable`; unparseable output throws `AiUnavailable`; the request has `output_config.format` with `type: "json_schema"`; no request sets a forced `tool_choice`; Sonnet requests use `client.beta.messages.create` with `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`; Haiku requests omit both.
- [ ] **Step 4: Run them.** Expected: FAIL.
- [ ] **Step 5: Implement.** Order in the handler: method, auth, validation, quota, action. `getUser` calls `GET {SUPABASE_URL}/auth/v1/user`. `consumeQuota` calls the RPC with the user's token. Keep the public URL and anon key in `lib/config.js`, so `ANTHROPIC_API_KEY` remains the only Netlify variable. Set a 50-second SDK timeout and `maxRetries: 1`. Use effort `medium` for Sonnet and `low` for Haiku. Move the current analyze and screenshot prompts to `prompts.js`; `analyze` returns `{ text }` for now and loads data with `loadEntries`.
- [ ] **Step 6: Update the browser.** `aiRequest` gets the session from `supabaseClient.auth.getSession()`, sends the Bearer token, and on a 401 calls `refreshSession()` and retries once. Replace both `fetch('/.netlify/functions/analyze')` calls.
- [ ] **Step 7: Verify.** Run `npm test`. Expected: PASS.
- [ ] **Step 8: Commit.** `feat: replace open proxy with authenticated AI function`

### Task 4: Accounts

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `user_settings` from Task 2.
- Produces: a required password screen when `user_settings.password_set_at` is null, and a change-password option in the header menu.

- [ ] **Step 1: Remove sign-up.** Delete `#authSignUpBtn` and its handler. Sign-in copy: "Accounts are invite-only. Forgot your password? Ask the person who invited you."
- [ ] **Step 2: Add password setting.** After sign-in, a missing row or null `password_set_at` shows a new-password form (minimum 10 characters) using `auth.updateUser`, then upserts `password_set_at`. Existing accounts see this once too.
- [ ] **Step 3: Verify.** Serve `public/` locally with `netlify dev`. Confirm there's no sign-up button, and that a test account is sent to the password screen and then reaches the app.
- [ ] **Step 4: Commit.** `feat: make accounts invite-only with required password change`

### Task 5: Ship security

The release runs in this exact order, and Task 17's public repo is its last step:

1. Run the SQL.
2. Turn sign-ups off and confirm anonymous sign-ins are off.
3. Rotate the key, revoke the old one, and set the spend limit.
4. Deploy and confirm `/.netlify/functions/analyze` returns 404.
5. Only then make the repo public.

- [ ] **Step 1: HANDOFF, before deploying.** In this order, the owner:
  1. Runs `supabase/schema.sql` in the SQL editor.
  2. Turns public sign-ups off, confirms anonymous sign-ins are off, and reviews existing accounts.
  3. Reviews Anthropic usage since July, rotates the key in Netlify, revokes the old key, and sets a monthly spend limit.
- [ ] **Step 2: Deploy with the owner's go-ahead.** Run `npm install`. A CLI deploy can upload the old `analyze` function still sitting in the local build folder, so delete `.netlify/functions` by hand first, then run `netlify deploy --prod`. Delete nothing else in `.netlify/`.
- [ ] **Step 3: Verify against the live URL.** The first check must pass before anything is made public.
  - `POST /.netlify/functions/analyze` returns 404.
  - `POST /.netlify/functions/ai` with no token returns 401.
  - `GET /schema.sql` returns 404.
  - Signed in, Analyze and screenshot import both work.
  - Calling `consume_ai_quota` 6 times for `analyze` returns false on the sixth.
- [ ] **Step 4: HANDOFF.** Owner creates accounts in Supabase and shares temporary passwords.

---

## Phase 2: Structure

### Task 6: Split into modules with no visible change

**Files:**
- Create: `public/css/{tokens,base,components}.css`
- Create: `public/js/{app,auth,data,today,forms,history,insights,ui,dates}.js`
- Modify: `public/index.html`, `netlify.toml`
- Test: `tests/data.test.js`, `tests/dates.test.js`, `tests/ui.test.js`

**Interfaces:**
- Produces:
  - `localDate(d = new Date()) -> 'YYYY-MM-DD'`
  - `createSupabaseBackend(client) -> Backend`
  - `escapeHtml(s) -> string`
  - `Backend`: `listDay(date)`, `listAll()`, `add(date, entry)`, `update(id, date, entry)`, `remove(id)`, `listMeds()`, `addMed(med)`, `removeMed(id)`, `getSettings()`, `saveSettings(patch)`, `getInsight()`, `saveInsight(result)`, `listTrials()`, `saveTrial(trial)`, `ai(action, payload)`
  - `setBackend(backend)` and `data()`. Every screen goes through `data()`, never Supabase directly.
  - `listAll()` keeps the current shape: `[{date, entries: [{id, type, time, ...data}]}]`.

- [ ] **Step 1: Write the failing tests.**
  - `localDate` at 23:30 local returns that local date, with `TZ=America/Los_Angeles`, unlike `toISOString`.
  - `listAll` keeps requesting ranges until a page returns under 1,000 rows, using a fake client with 2,350 rows.
  - `escapeHtml('<img src=x>')` contains no `<`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Move code by responsibility.** No behavior changes other than `localDate` and paging. Remove the inline script and all `on*` attributes, then remove `'unsafe-inline'` from `script-src`, and assert that in `tests/config.test.js`.
- [ ] **Step 4: Verify.** Run `npm test`. Then, with `netlify dev`, exercise add, edit, delete, history, print view, meds list, screenshot import and Analyze. Check that the browser console has no CSP errors.
- [ ] **Step 5: Commit.** `refactor: split app into modules with a data layer`

---

## Phase 3: New experience

### Task 7: Warm paper and Low light styling

**Files:**
- Modify: `public/css/*`

- [ ] **Step 1: Set tokens.** Keep the Warm paper palette and Fraunces. Add Low light values under `@media (prefers-color-scheme: dark)`: background `#1b1f24`, surface `#252a31`, line `#333a42`, text `#d9d4c8`, accent `#a9714b`.
- [ ] **Step 2: Size controls.** Interactive targets are at least 44px. The `prefers-reduced-motion` rule stays.
- [ ] **Step 3: Verify.** Text contrast is at least 4.5:1 in both themes. Check at 390px wide in light and dark.
- [ ] **Step 4: Commit.** `style: apply Warm paper with Low light dark mode`

### Task 8: Today screen and short forms

**Files:**
- Modify: `public/index.html`, `public/js/{today,forms,app}.js`
- Test: `tests/forms.test.js`

**Interfaces:**
- Consumes: `data()` from Task 6.
- Produces: `submitEntry(date, entry) -> Promise<{ok: boolean, error?: string}>`, and `openSheet(type)`.

- [ ] **Step 1: Write the failing tests.** `submitEntry` with a backend that rejects returns `{ok: false}` and keeps the draft, and a backend that succeeds clears it. Tile status: `tileStatus('meds', entries, catalog)` returns `'1 of 2 taken'`, and `tileStatus('sleep', ...)` returns `'6.5 hrs'`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Build Today.** Layout per the spec: date header, headache button, tiles for Food, Sleep, Meds and More, then "Logged today". Tabs become Today, History, Insights. Each sheet shows one type. Time defaults to now behind "change time". Screenshot import moves inside the Food, Sleep and Exercise sheets. A failed save shows the error and a Retry button.
- [ ] **Step 4: Verify.** Run `npm test`. Then, with `netlify dev`, log every type. Check that print view, meds list, period tracking and the overuse warning still work.
- [ ] **Step 5: Commit.** `feat: add tile-based Today screen and short forms`

### Task 9: Headache flow

**Files:**
- Create: `public/js/headache.js`
- Modify: `public/js/{today,forms}.js`
- Test: `tests/headache.test.js`

**Interfaces:**
- Produces:
  - `findOpenHeadache(days) -> Entry|null`
  - `startHeadache(days, now) -> Entry|null`, which returns null when one is open
  - `endHeadache(entry, endAt) -> Entry`, which sets `open: false`, `duration`, `end_at`
  - `isStale(entry, now) -> boolean`, true after 24 hours
  - `headacheDates(entry) -> string[]`
  - `isHeadacheEntry(entry) -> boolean`

- [ ] **Step 1: Write the failing tests.**
  - A second `startHeadache` while one is open returns null. Disable the button while the save is in flight.
  - Old entries with a blank `duration` and no `open` field are not open.
  - `isStale` is false at 23h59m and true at 24h.
  - A headache from 22:00 Monday to 02:00 Tuesday gives both dates.
  - An open headache gives only its start date.
  - A headache with `severity: null` still counts for `isHeadacheEntry`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement and wire up.** One tap saves `{type: 'headache', open: true}`, then opens the optional details sheet. While one is open the button reads "My headache ended". A stale headache asks "Still going?" and offers an end time. "Log an earlier headache" sits under More. Replace the `severity != null` filter in the existing analysis code with `isHeadacheEntry`.
- [ ] **Step 4: Verify.** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit, and deploy with the owner's go-ahead.** `feat: add one-tap headache logging`

---

## Phase 4: Food

### Task 10: Food splitting

**Files:**
- Create: `public/js/food.js`, `netlify/functions/lib/food.js`
- Modify: `netlify/functions/lib/prompts.js`, `netlify/functions/ai.js`, `public/js/{forms,app}.js`
- Test: `tests/food.test.js`, extend `tests/ai-handler.test.js`

**Interfaces:**
- Consumes: `aiRequest` through `data().ai`, and `user_settings.ai_notice_seen_at`.
- Produces:
  - action `split_food`: payload `{text}`, returns `{items: Item[]}`
  - `Item`: `{name, main_macro, food_type, protein_g, carbs_g, fat_g, tags, edited?}`
  - `FOOD_SCHEMA`, `validateItems(items) -> Item[]`
  - `mergeItems(existing, incoming) -> Item[]`
  - `splitEntry(date, entry) -> Promise<void>`, which never throws
  - `canSendToAi(settings) -> boolean`

Allowed values:
- `main_macro`: `protein`, `carbs`, `fat`
- `food_type`: `meat_fish`, `dairy`, `grains`, `fruit_veg`, `legumes_nuts`, `sweets_snacks`, `drinks`, `other`
- `tags`: `caffeine`, `alcohol`, `aged_cheese`, `processed_meat`, `chocolate`, `msg`, `artificial_sweetener`

- [ ] **Step 1: Write the failing tests.**
  - `validateItems` drops unknown tags, and rejects an unknown `food_type` by mapping it to `other`.
  - `mergeItems` keeps every item with `edited: true`.
  - `splitEntry` with a failing backend leaves `text` intact and sets `split_status: "failed"`.
  - `splitEntry` makes no AI call when `canSendToAi` is false, and the status stays `pending`.
  - The handler rejects `split_food` text over 2,000 characters.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Save first with `split_status: "pending"`, then split without blocking the form. Use the sample in the spec as the prompt's example. Add the one-time AI notice, shown once at first sign-in with a "Got it" button that sets `ai_notice_seen_at`. Copy: "To sort your food and find patterns, what you log here is sent to Anthropic, the company behind Claude. This app isn't a diagnosis."
- [ ] **Step 4: Verify.** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: split food entries into classified items`

### Task 11: Food display and editing

**Files:**
- Modify: `public/js/{food,today,history,forms}.js`
- Test: extend `tests/food.test.js`

**Interfaces:**
- Consumes: `Item`, `mergeItems` from Task 10.
- Produces: `dayTotals(entries) -> {protein_g, carbs_g, fat_g}`, `triggerTags(entries) -> string[]`, and `formatAmount(grams, macro) -> string`.

- [ ] **Step 1: Write the failing tests.** `dayTotals` sums across entries and ignores pending ones. `triggerTags` returns unique tags. `formatAmount(9, 'fat')` returns `'~9g fat'`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Show items with tags. Failed entries show "Couldn't sort this yet" with Retry. Tapping an item allows edit and delete, and an Add button adds one; each saved change sets `edited: true`. Add estimated day totals. On app open, retry pending entries from the last 7 days, up to 5 per open.
- [ ] **Step 4: Verify.** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: show and edit food items with day totals`

### Task 12: Split old food entries

**Files:**
- Modify: `public/js/food.js`, `public/js/app.js`, `netlify/functions/ai.js`
- Test: extend `tests/food.test.js`

**Interfaces:**
- Produces: action `backfill_food` with the same payload and result as `split_food`, and `pickBackfillBatch(days, size = 10) -> Entry[]`.

- [ ] **Step 1: Write the failing tests.** The batch takes the newest unsplit entries first, skips entries with any edited item, and returns at most 10. The backfill stops quietly on a 429 and doesn't mark entries failed.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Run one batch per app open, one request at a time, only after `canSendToAi`. Parse the old format too: screenshot entries that have macros in brackets keep their full text.
- [ ] **Step 4: Verify and ship.** Run `npm test`. Deploy with the owner's go-ahead.
- [ ] **Step 5: Commit.** `feat: gradually split existing food entries`

---

## Phase 5: Insights

### Task 13: Pattern engine

**Files:**
- Create: `public/js/patterns.js`
- Test: `tests/patterns.test.js`

**Interfaces:**
- Consumes: `headacheDates`, `isHeadacheEntry` from Task 9.
- Produces:
  - `buildStats(days, {now}) -> Stats`
  - `Stats`: `{attacks, headacheDays, loggedDays, factors: [{key, label, beforeHeadache, headacheTotal, controlHits, controlTotal, confidence}], cycle, acuteMedDays30, gaps}`
  - `confidenceFor(hits, total) -> 'early guess'|'moderate'|'strong'`
  - `ruleSuggestion(stats, pastTrials) -> InsightResult`

No browser APIs, so the function can import it.

- [ ] **Step 1: Write the failing tests.**
  - A food in 3 of 5 lookbacks and 6 of 40 control windows reports those exact counts.
  - Two spellings in different entries count once when `items` have the same lowercased name.
  - Entries with `time: null` are treated as 12:00 and don't throw.
  - An item logged at 23:50 is inside the window for a headache at 00:30 the next day.
  - A factor seen in only one lookback is at most `early guess`.
  - Zero days gives a valid result whose suggestion says what to log and for how long.
  - Zero headaches gives a valid "keep logging" suggestion.
  - One headache with no food logged gives a valid suggestion.
  - `ruleSuggestion` never repeats a factor from a completed trial with no improvement.
  - `ruleSuggestion` never targets `main_macro` values.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use a 48-hour lookback from each start time. Build control windows from 48-hour spans that touch no headache day, and document the choice at the top of the file. Food factors cover item names, `food_type` and tags, plus sleep bands under 6, 6 to 7 and 7+ hours.
- [ ] **Step 4: Verify.** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat: compare headache and headache-free windows`

### Task 14: Actionable Insights

**Files:**
- Create: `netlify/functions/lib/insight.js`
- Modify: `netlify/functions/lib/prompts.js`, `netlify/functions/ai.js`, `public/js/insights.js`, `public/index.html`, `supabase/schema.sql`
- Test: `tests/insight.test.js`, extend `tests/ai-handler.test.js`, `tests/schema.test.js`

**Interfaces:**
- Consumes: `buildStats`, `ruleSuggestion`, `Stats`.
- Produces:
  - table `insights(user_id uuid primary key default auth.uid(), result jsonb, created_at timestamptz)`
  - `INSIGHT_SCHEMA`, using the JSON shape in the spec
  - `validateInsight(result, {medNames}) -> InsightResult|null`
  - `analyze` returns `{ result, source: 'ai'|'rules' }`
  - `renderInsight(result, container)`

- [ ] **Step 1: Write the failing tests.**
  - `validateInsight` returns null with no `try_next`.
  - It returns null when `try_next` mentions `stop taking`, `dose`, or a name from `medNames`.
  - It returns null for advice to cut `carbs`, `protein` or `fat` as a whole group.
  - The `analyze` handler returns `source: 'rules'` when `callClaude` throws or validation fails, so a result always appears.
  - `renderInsight` with `<img src=x onerror=alert(1)>` in a field creates no `img` element, tested with a small fake DOM or by asserting `textContent` is used.
  - The food chart counts items rather than whole lines.
  - Saved results load without an AI call.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Claude receives the stats, a compact log of the last 120 days and past trials. Sonnet at `medium` effort with `maxTokens: 4000`. Render per the mockup: "Try this next", "Also watching", "Keep logging", doctor questions. The not-a-diagnosis note stays. Keep the sleep, cycle, food and meds charts below.
- [ ] **Step 4: Verify.** Run `npm test`, then run one real analysis through `netlify dev` and record the duration. It must be under 50 seconds.
- [ ] **Step 5: Commit.** `feat: always give a suggestion in Insights`

### Task 15: Tracked trials

**Files:**
- Create: `public/js/trials.js`
- Modify: `public/js/{insights,today}.js`, `supabase/schema.sql`, `netlify/functions/lib/prompts.js`
- Test: `tests/trials.test.js`, extend `tests/schema.test.js`

**Interfaces:**
- Consumes: `try_next`, `headacheDates`, `Backend.listTrials`, `Backend.saveTrial`.
- Produces:
  - table `trials(id, user_id, suggestion jsonb, start_date, end_date, status, result jsonb, created_at)`, with an own-row policy
  - `startTrial(tryNext, today) -> Trial`
  - `activeTrial(trials) -> Trial|null`
  - `trialDay(trial, today) -> {day, total}`
  - `reviewTrial(trial, days) -> {before, during, summary}`

- [ ] **Step 1: Write the failing tests.**
  - `trialDay` for a 14-day trial started 5 days ago returns `{day: 6, total: 14}`.
  - `reviewTrial` compares headache days per week across equal-length periods.
  - With no data before the trial, the summary says there's nothing to compare against.
  - Every summary states that one trial can't prove cause.
  - Starting a second trial while one is active returns null.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** "Start this" on `try_next` creates the trial. Today shows "Sleep trial: day 6 of 14". While a trial is active, Insights shows it in place of Analyze, with "Stop this trial". When it ends, show the review with Keep or Analyze actions. List past trials and pass them to `analyze`.
- [ ] **Step 4: Verify and ship.** Run `npm test`. **HANDOFF:** owner runs the updated SQL. Deploy with the owner's go-ahead.
- [ ] **Step 5: Commit.** `feat: add tracked trials with end-of-trial review`

---

## Phase 6: Portfolio

### Task 16: Sample-data demo

**Files:**
- Create: `public/js/demo.js`, `public/js/demo-data.js`
- Modify: `public/js/{app,auth}.js`, `public/index.html`
- Test: `tests/demo.test.js`

**Interfaces:**
- Consumes: the `Backend` interface, `setBackend`.
- Produces: `createDemoBackend() -> Backend`.

- [ ] **Step 1: Write the failing tests.**
  - Every `Backend` method exists on the demo backend.
  - `ai()` makes no network call and returns pre-written data.
  - Entries added in the demo appear in `listDay`, and a new backend starts clean.
  - Sample data covers at least 56 days, with one active trial and one completed trial.
  - `buildStats` runs on the sample data and finds at least one factor.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** "View demo" on the sign-in screen calls `setBackend(createDemoBackend())` and shows the app with a fixed "Demo: sample data" banner linking to sign-in. Use wholly invented data. The Supabase client isn't called in demo mode.
- [ ] **Step 4: Verify.** With `netlify dev`, open the demo and use every screen with the Network tab open. Expected: no requests to Supabase or `/.netlify/functions/ai`.
- [ ] **Step 5: Commit.** `feat: add sample-data demo`

### Task 17: README and GitHub

**Files:**
- Create: `README.md`, `docs/screenshots/*`

- [ ] **Step 1: Write the README.** Cover what the app is, live and demo links, screenshots from the demo, an architecture summary, the security approach, how the Insights engine works, and how to run tests.
- [ ] **Step 2: Scan for secrets.** Run `git log -p --all | grep -Ei 'sk-ant|service_role'`. Expected: the only hits are the fake test strings (`sk-ant-test-secret-key`, `sk-ant-secret`) and this plan's own text. Anything else is a real leak, so stop.
- [ ] **Step 3: Check tracked files.** Run `git ls-files`. Expected: no `.superpowers`, `.netlify`, `.claude`, `.agents`.
- [ ] **Step 4: Commit.** `docs: add README`
- [ ] **Step 5: HANDOFF.** This is step 5 of the release order in Task 5, so it comes only after the SQL has run, sign-ups are off, the key is rotated, and the deploy shows `/.netlify/functions/analyze` returning 404. With the owner's approval, create the public GitHub repo, push `main`, and connect it to Netlify so pushes deploy automatically. `netlify.toml` sets Node 24. The `gh` CLI isn't installed, so the owner either creates the repo on github.com or runs `brew install gh`.
- [ ] **Step 6: Verify.** A pushed change deploys. The live site and demo both load, and the checks in Task 5 Step 3 still pass.
