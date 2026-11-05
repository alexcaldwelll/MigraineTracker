import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const lower = sql.toLowerCase();

test('ai_usage has RLS on and no policies', () => {
  assert.match(lower, /create table if not exists ai_usage/);
  assert.match(lower, /alter table ai_usage enable row level security/);
  assert.doesNotMatch(lower, /create policy[^;]*\bon ai_usage\b/);
  assert.match(lower, /primary key \(user_id, day, action\)/);
});

test('consume_ai_quota is a hardened security definer function', () => {
  assert.match(lower, /create or replace function consume_ai_quota\(p_action text\)\s+returns boolean/);
  assert.match(lower, /security definer/);
  assert.match(lower, /set search_path = public/);
  assert.match(lower, /auth\.uid\(\)/);
  assert.match(lower, /on conflict \(user_id, day, action\) do update/);
  assert.match(lower, /where u\.count < v_limit/);
});

test('execute is revoked from public/anon and granted to authenticated', () => {
  assert.match(lower, /revoke execute on function consume_ai_quota\(text\) from public, anon/);
  assert.match(lower, /grant execute on function consume_ai_quota\(text\) to authenticated/);
});

test('the four actions carry their limits', () => {
  for (const [action, limit] of [['split_food', 40], ['analyze', 5], ['read_screenshot', 10], ['backfill_food', 100]]) {
    assert.match(sql, new RegExp(`when '${action}' then ${limit}\\b`), action);
  }
});

test('user_settings has an own-row policy', () => {
  assert.match(lower, /create table if not exists user_settings/);
  assert.match(lower, /user_id uuid primary key default auth\.uid\(\)/);
  assert.match(lower, /ai_notice_seen_at timestamptz/);
  assert.match(lower, /password_set_at timestamptz/);
  assert.match(lower, /alter table user_settings enable row level security/);
  assert.match(lower, /create policy "users manage their own settings"\s+on user_settings for all\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/);
});

test('insights holds one row per person with an own-row policy', () => {
  assert.match(lower, /create table if not exists insights/);
  assert.match(lower, /user_id uuid primary key default auth\.uid\(\)/);
  assert.match(lower, /result jsonb not null/);
  assert.match(lower, /created_at timestamptz not null default now\(\)/);
  assert.match(lower, /alter table insights enable row level security/);
  assert.match(lower, /create policy "users manage their own insights"\s+on insights for all\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/);
});

test('trials has an own-row policy and defaults', () => {
  assert.match(lower, /create table if not exists trials/);
  assert.match(lower, /id uuid primary key default gen_random_uuid\(\)/);
  assert.match(lower, /user_id uuid not null default auth\.uid\(\) references auth\.users/);
  assert.match(lower, /suggestion jsonb not null/);
  assert.match(lower, /start_date date not null/);
  assert.match(lower, /end_date date not null/);
  assert.match(lower, /status text not null default 'active' check \(status in \('active', 'completed', 'stopped'\)\)/);
  assert.match(lower, /result jsonb,/);
  assert.match(lower, /created_at timestamptz not null default now\(\)/);
  assert.match(lower, /alter table trials enable row level security/);
  assert.match(lower, /create policy "users manage their own trials"\s+on trials for all\s+using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/);
});

test('every statement is safe to re-run', () => {
  assert.doesNotMatch(lower, /create table (?!if not exists)/);
  assert.doesNotMatch(lower, /create index (?!if not exists)/);
  assert.doesNotMatch(lower, /create function/);
  const policies = lower.match(/create policy "[^"]+"\s+on \w+/g) || [];
  for (const p of policies) {
    const [, name, table] = p.match(/create policy ("[^"]+")\s+on (\w+)/);
    assert.ok(lower.includes(`drop policy if exists ${name} on ${table};`), p);
  }
});

const APP_TABLES = ['entries', 'meds_catalog', 'user_settings', 'insights', 'trials'];

test('the signed-in role gets exactly the table rights the app uses, and anon gets none', () => {
  assert.match(lower, /grant select, insert, update, delete on entries, meds_catalog, user_settings, insights, trials to authenticated;/);
  assert.match(lower, /revoke all on ai_usage from anon, authenticated;/);
  assert.match(lower, /revoke all on entries, meds_catalog, user_settings, insights, trials from anon;/);
  assert.match(lower, /revoke all on entries, meds_catalog, user_settings, insights, trials from authenticated;/);
  assert.ok(lower.indexOf('trials from authenticated;') < lower.indexOf('grant select, insert, update, delete'), 'TRUNCATE must go before the grant');
  assert.doesNotMatch(lower, /\bgrant\b[^;]*\bto\b[^;]*\banon\b/);
  const grants = lower.match(/\bgrant\b[^;]*\bon\b[^;]*;/g).join(' ');
  assert.doesNotMatch(grants.replace(/grant execute[^;]*;/, ''), /ai_usage/);
});

test('table rights come after every table they name', () => {
  const grant = lower.indexOf('grant select, insert, update, delete');
  for (const table of [...APP_TABLES, 'ai_usage']) {
    assert.ok(lower.indexOf(`create table if not exists ${table}`) < grant, table);
  }
  assert.ok(lower.indexOf('create table if not exists ai_usage') < lower.indexOf('revoke all on ai_usage'));
});

test('consume_ai_quota cannot be misled by a temporary schema', () => {
  assert.match(lower, /set search_path = public, pg_temp\n/);
});

test('deleting an account deletes its rows from every table', () => {
  for (const table of ['ai_usage', 'user_settings', 'insights', 'trials']) {
    const create = lower.match(new RegExp(`create table if not exists ${table} \\([\\s\\S]*?\\n\\);`))[0];
    assert.match(create, /references auth\.users on delete cascade/, table);
  }
});

test('tables that already exist are moved to cascading foreign keys, and a re-run changes nothing', () => {
  const block = lower.match(/do \$\$[\s\S]*?\$\$;/)[0];
  for (const table of [...APP_TABLES, 'ai_usage']) assert.match(block, new RegExp(`'${table}'`), table);
  assert.match(block, /confdeltype <> 'c'/);
  assert.match(block, /drop constraint %i/);
  assert.match(block, /add constraint %i foreign key \(user_id\) references auth\.users on delete cascade/);
  assert.ok(lower.indexOf('do $$') > lower.indexOf('create table if not exists trials'));
});
