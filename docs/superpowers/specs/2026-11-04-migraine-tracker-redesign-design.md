# Migraine Tracker Redesign: Design

Date: 2026-11-04
Status: Approved by the owner on 2026-11-04

## Intent

Migraine & Trigger Log is a personal web app for logging headaches and possible
triggers. It will be used by about 5 invited family and friends and shown to
employers through a public GitHub repo.

The redesign exists for four reasons, all from the owner:

1. Logging should be simpler and easier for people to keep doing.
2. "No pattern found" was a useless result. People should always get advice:
   keep tracking, try cutting a food or food group, change something about
   sleep, or any other reasonable guess to try.
3. A food entry can hold several meals or ingredients. It must be split into
   items and classified by fats, carbs, protein and so on.
4. Nobody else should be able to use the API key or run requests on it.

## Goals

- A home screen that gets a headache logged in one tap, and anything else in a
  few taps.
- Food text split into separate items with food groups and estimated amounts.
- An Insights result that always ends in a concrete suggestion, with honest
  confidence and evidence counts.
- An AI endpoint usable only by invited, signed-in people, within daily limits.
- A public repo with no secrets, readable code and real tests.
- A demo employers can click without an account.

## Non-goals

- Native apps, push reminders, or wearable integrations.
- Open public sign-up or scaling beyond a small invited group.
- A rewrite in React or another framework.
- Sharing data between users.
- Replacing the Supabase project or moving hosting off Netlify.

## Anti-goals

The work has failed, even if it technically runs, if:

- A result says, in effect, "no pattern" and leaves the person with nothing to do.
- A weak guess is presented as a finding. Every suggestion shows its confidence
  and counts.
- The app suggests starting, stopping or changing medication. It may only
  suggest raising medication questions with a doctor.
- A log is lost because the AI was slow, down or over its limit.
- A demo visitor can reach real data or trigger an AI call.
- Logging during a migraine requires reading or typing.

## Constraints

- Hosted on Netlify. Data and auth stay in the existing Supabase project, and
  existing entries must keep working.
- GitHub Pages is not an option because the app needs a server function.
- No build step.
- The Supabase anon key may stay in client code because it is public by design
  (confirmed: the JWT role is `anon`, and no secrets appear in git history).
  Row-level security must protect all user data.
- Must work well at phone width, and respect reduced-motion settings.
- This is health data: the app must say plainly that logged data is sent to
  Anthropic for AI features, and the app is not a diagnosis. The owner chose a
  one-time notice with no opt-out. Each person sees it once, and it is recorded.
  Nothing of theirs is sent automatically until they have seen it, including
  splitting of their old entries.

## Approaches

| Approach | Trade-off |
|---|---|
| 1. Keep a single `index.html` | Least setup, but about 1,280 lines that would grow a lot, hard to test or read |
| **2. Split into plain files with no build step (chosen)** | Clean structure and real tests while improving working code, but a less familiar resume stack than React |
| 3. Rebuild in React and TypeScript | Most recognizable stack, but a full rewrite with a build step and more risk, and no benefit to users |

The owner chose approach 2. It gives employers tidy, tested code the owner can
explain, without discarding what works.

## Decided by the owner

- **Home screen:** one-tap tiles, with a large "I have a headache" button first
  (option A in the mockups).
- **Look:** Warm paper: a cleaned-up version of the current palette.
- **Audience:** about 5 family and friends, invited.
- **Employers:** a sample-data demo.
- **Code:** public on GitHub.
- **Insights:** always gives a recommendation or best guess.
- **Suggestions:** tracked trials with a review at the end.
- **Accounts:** the owner creates them by hand, with no email service.
- **AI data notice:** a one-time notice, with no opt-out.
- **Food:** split items and classify them by fats, carbs, protein and so on.

## Proposed by Claude, accepted in conversation or awaiting review

These were presented and not objected to, but the owner did not originate them:

- Low light as an automatic dark mode. This was explicitly left open to veto.
- Hosting stays on Netlify, deployed automatically from GitHub, with the live
  link in the README.
- Trigger tags on food items, fixing items by tapping them, and splitting old
  food entries.
- One suggestion at a time, for a set period, with confidence labels.

## Design

### Screens

Three tabs: **Today**, **History**, **Insights**.

**Today**

- Date header with a way to move to another day.
- Large "I have a headache" button.
- Tiles: Food, Sleep, Meds, More (water, period, early signs, exercise, notes).
  Each tile shows a short status such as "2 today" or "1 of 2 taken".
- A "Logged today" list. Tapping an entry edits it.

Each tile opens a short form for that entry type only. Time defaults to now and
sits behind a small "change time" link. Optional detail stays collapsed.

**Headache flow:** the button saves a headache immediately with the current
time. A follow-up sheet then offers severity and symptoms, all optional. While a
headache is open, the button becomes "My headache ended", which records the
duration. A headache without a severity still counts as a headache day
everywhere. Today's analysis code ignores those entries, and that must change.

Open headache rules (Claude's calls):

- New headaches store `open: true` until ended. Old entries with a blank duration
  count as closed, never open.
- After 24 hours open, the app asks "Still going?" and offers an end time, so a
  forgotten headache never records a false duration. Only one can be open at a
  time, and "log an earlier headache" stays available from More.
- A headache that crosses midnight is one attack in attack counts, and each
  calendar date it touches is a headache day. Its 48-hour lookback runs from
  its start time. Open headaches with no end time count only their start date.

Screenshot import stays, inside the Food, Sleep and Exercise forms rather than
above them. The meds list, printable doctor view, period and cycle tracking,
early signs, and medication-overuse warning all stay.

**Visual style:** Warm paper palette, with the Fraunces heading font. Low light
is applied through `prefers-color-scheme: dark`. Use large tap targets and calm
motion.

### Food

1. The person types anything and taps Save. The entry saves at once with its
   raw text and `split_status: "pending"`.
2. The app asks the AI endpoint to split it. Results are written to the same
   entry's `data`, which leaves the table shape unchanged:

   ```json
   {
     "text": "turkey sandwich with cheddar, an iced coffee",
     "split_status": "done",
     "items": [
       {
         "name": "cheddar",
         "main_macro": "fat",
         "food_type": "dairy",
         "protein_g": 7,
         "carbs_g": 1,
         "fat_g": 9,
         "tags": ["aged_cheese"]
       }
     ]
   }
   ```

3. Each item has two classifications (Claude's call, so that "fats, carbs,
   protein" tracking and "cut a food group" advice both work):
   - `main_macro`: `protein`, `carbs` or `fat`, plus estimated grams. Used for
     tags and day totals.
   - `food_type`: `meat_fish`, `dairy`, `grains`, `fruit_veg`, `legumes_nuts`,
     `sweets_snacks`, `drinks` or `other`. Suggestions may target these, and
     must never target a macro.
4. Trigger tags: `caffeine`, `alcohol`, `aged_cheese`, `processed_meat`,
   `chocolate`, `msg`, `artificial_sweetener`.
5. If splitting fails or the limit is reached, the entry remains saved and shows
   a small "couldn't sort this yet" state with a retry. A later pass retries
   pending entries.
6. Tapping an item allows editing, adding or deleting it. Edits are never
   overwritten by AI.
7. Amounts always display as estimates using "~".
8. Old food entries are split gradually in small batches when the owner of those
   entries opens the app. This counts against a separate backfill allowance
   rather than the daily logging limit.

### Insights

Two layers: code finds the evidence, then Claude explains it.

**`patterns.js`** is a pure, unit-tested module with no network or DOM access. For
each headache it looks at the 48 hours before the start time. It compares how
often each food item, tag, food group, sleep band and other logged factor appears
in those windows against headache-free control windows. The output includes counts
such as "before 3 of 5 headaches and on 6 of 40 headache-free days", plus
cycle-day clustering, acute medication days and logging gaps.

**Claude** receives those stats and a compact log, then returns structured JSON:

```json
{
  "try_next": {
    "title": "Aim for 7+ hours of sleep",
    "action": "Do this for the next 2 weeks",
    "why": "4 of your 5 headaches followed a night under 6 hours",
    "confidence": "low",
    "days": 14
  },
  "also_watching": [{ "item": "Cheese", "evidence": "..." }],
  "keep_logging": "Sleep is missing on 9 days",
  "doctor_questions": ["..."],
  "cycle_note": null,
  "medication_note": null
}
```

Rules enforced by prompt and by response validation:

- `try_next` is always present.
- Confidence is `early guess`, `moderate` or `strong`, based on the counts.
- Only one change at a time, for a stated period.
- Food suggestions target a specific food or narrow group for 2 to 4 weeks. Never
  suggest removing a whole macronutrient. Anything more restrictive becomes a
  doctor question.
- Never suggest starting, stopping or changing medication.
- If the AI fails, fall back to a rule-based suggestion from `patterns.js` so
  a result always appears. With very little data, the suggestion is what to log
  next and for how long.

The latest result is stored per user in a new `insights` table so that it reloads
without another AI call. The existing not-a-diagnosis note stays.

**Tracked trials (owner's decision):**

- A "Start this" button turns `try_next` into a trial, stored in a new row-level
  secured `trials` table with the suggestion, start and end dates, status
  (`active`, `completed`, `stopped`) and result.
- Today shows a small card such as "Sleep trial: day 6 of 14".
- Only one trial runs at a time. While it runs, Analyze doesn't replace it. Insights
  shows the trial, and offers "Stop this trial" if the person wants something else.
- When the end date passes, `patterns.js` compares headache days per week during the
  trial with the same number of days before it. The result is shown in plain words
  with its counts, and an honest note that one trial can't prove cause.
- The person can then keep the change, or run Analyze for the next suggestion. Past
  trials are listed in Insights and passed to Claude, so it doesn't repeat one that
  didn't help.

### Security

**API:** replace the open proxy with `netlify/functions/ai.js`:

- Requires `Authorization: Bearer <supabase access token>`, verified against
  Supabase Auth. No valid session returns 401.
- Accepts an `action` of `split_food`, `analyze` or `read_screenshot`.
- The browser cannot choose the prompt, model or token limit. These live on the
  server.
- `analyze` loads the person's own entries from Supabase using their token, so
  row-level security applies, rather than trusting data sent by the browser.
- Validates sizes: food text up to 2,000 characters, screenshots up to about 4 MB
  in JPEG, PNG or WebP only.
- Error responses never reveal internals or keys.

**Limits:** a new `ai_usage` table holds per-user daily counts. A
`consume_ai_quota(action)` security-definer function increments the count and
enforces limits atomically, returning 429 when exceeded. Users cannot write to the
table directly.

| Action | Daily limit per user |
|---|---|
| `split_food` | 40 |
| `analyze` | 5 |
| `read_screenshot` | 10 |

**Accounts (owner's decision):** disable public sign-ups in Supabase and remove the
sign-up button. The owner creates each account in the Supabase dashboard with a
temporary password and shares it directly. No email service is used, because
Supabase's built-in email only reaches project team members, at 2 messages an hour.

- New accounts are flagged so the first sign-in requires choosing a new password.
- The app has a change-password screen.
- There is no self-service "forgot password". The sign-in screen tells people to
  ask the owner, who resets it in the dashboard.
- Check the existing accounts before disabling sign-ups.

**Browser hardening:**

- Add security headers in `netlify.toml`, including a Content-Security-Policy
  limited to the app, Supabase, and the font and script sources it uses.
- Pin the Supabase script to an exact version.
- Render all user and AI text with escaping or `textContent`.
- Publish only `public/`. Today the live site serves the whole project folder,
  including `schema.sql`.

**Owner actions outside the code:** the builder has no dashboard access, so each
delivery step must list these as handoffs.

- Run the new SQL in Supabase before deploying the function that depends on it.
- Disable public sign-ups and create the accounts in Supabase.
- Add any new Netlify environment variables.
- Review Anthropic usage for unexpected activity since July, because the function
  has been open, and rotate the API key.
- Set a monthly spend limit in the Anthropic Console.
- Confirm `ANTHROPIC_API_KEY` exists only as a Netlify environment variable.

Security ships first and on its own, before any redesign work, because the open
function may be live today.

### Demo

"View demo" on the sign-in screen opens the real app without an account.

- `data.js` exposes one interface with two backends: Supabase and in-memory.
- The in-memory backend loads fictional sample data covering about 8 weeks and
  resets on refresh.
- The sample data includes an active trial and a completed one, so visitors can
  see the full loop.
- The demo makes no Supabase and no AI calls. Food items and the Insights result
  are pre-written sample data, and `patterns.js` runs on the sample data for real.
- A persistent "Demo: sample data" banner links back to sign-in.

### Code structure

```text
public/
  index.html
  css/         tokens, base, components
  js/          app, auth, data, demo, today, forms, history, insights, patterns, ui
netlify/functions/
  ai.js
  lib/         auth, quota, prompts, anthropic, validate
supabase/
  schema.sql
tests/         node:test for patterns, validation, food merge, and ai handler
docs/
README.md
netlify.toml
```

Use native ES modules and no front-end framework, and nothing in the browser needs
installing. The function calls Supabase with `fetch` and Anthropic through the
official `@anthropic-ai/sdk`, its only runtime dependency. Tests run with Node's
built-in test runner.

### Models

Use `claude-sonnet-5-5` for `analyze` and `read_screenshot`, and `claude-haiku-5-5`
for `split_food`, which is frequent and simple. The current app hardcodes an older
model.

Get JSON through structured outputs (`output_config.format`), because forced tool
use is rejected on `claude-sonnet-5-5`. Always check `stop_reason` before reading
content. Sonnet calls enable the server-side refusal fallback. A refusal or failure
falls through to the app's non-AI behavior. Netlify's synchronous limit is 60
seconds, so AI calls time out at 50 seconds and no background function is needed.

### Existing bugs to fix along the way

- `todayStr()` uses UTC, so evening entries can land on the wrong date. Use the
  local date. Old entries are left as they are (Claude's call): repair would mean
  guessing on health data, and a wrong date can't always be told from a backdated
  entry.
- `getAllDays()` reads without paging, so long histories can be cut off by
  Supabase's default row limit. Page through results.
- Food charts compare whole lines of text. Use split items.

### GitHub and repo

- Create a public repo and connect it to Netlify for automatic deploys.
- The README covers what the app is, the live and demo links, screenshots, the
  architecture, security approach, and how to run tests.
- Untrack the third-party `.claude/`, `.agents/` and `skills-lock.json` files,
  since they are not part of the app.
- Keep the existing uncommitted header layout changes in `index.html` as the
  starting point.

### Delivery order

1. Security: protected function, limits, invite-only, and hosting changes.
2. Split the code into files with no visible change, and add tests.
3. New Today screen, forms, headache flow, and Warm paper and Low light styling.
4. Food splitting and backfill.
5. Insights.
6. Demo, README and GitHub publishing.

Each step should leave the live app working.

## Left to the builder

- Exact CSS, spacing and module boundaries within the structure above.
- Exact prompt wording, within the rules above.
- How control windows are selected in `patterns.js`, provided they are documented
  and tested.
- Sample data content, which must be entirely fictional.
