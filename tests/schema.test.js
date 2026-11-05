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
