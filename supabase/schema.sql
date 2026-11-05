-- Run this in Supabase: Project → SQL Editor → New query → paste → Run
-- If you already ran the old version of this file, this is safe to re-run — it only adds what's missing.

create table if not exists entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null default auth.uid(),
  date date not null,
  time text,
  type text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table entries enable row level security;

drop policy if exists "Users manage their own entries" on entries;
create policy "Users manage their own entries"
  on entries for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create index if not exists entries_date_idx on entries (user_id, date);

-- Remembered medications so you can quick-tap "taken" instead of retyping each time
create table if not exists meds_catalog (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null default auth.uid(),
  name text not null,
  category text not null default 'other', -- preventive | acute | supplement | other
  default_dose text,
  created_at timestamptz default now()
);

alter table meds_catalog enable row level security;

drop policy if exists "Users manage their own meds catalog" on meds_catalog;
create policy "Users manage their own meds catalog"
  on meds_catalog for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Per-user, per-day AI usage counters. RLS is on with no policies, so clients
-- cannot read or write it directly; only consume_ai_quota (security definer) can.
create table if not exists ai_usage (
  user_id uuid references auth.users not null,
  day date not null,
  action text not null,
  count int not null default 0,
  primary key (user_id, day, action)
);

alter table ai_usage enable row level security;

-- Atomically spends one unit of today's quota for the signed-in user.
-- Returns true if allowed, false if over the limit, unknown action, or signed out.
create or replace function consume_ai_quota(p_action text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
begin
  if v_uid is null then
    return false;
  end if;

  v_limit := case p_action
    when 'split_food' then 40
    when 'analyze' then 5
    when 'read_screenshot' then 10
    when 'backfill_food' then 100
    else null
  end;

  if v_limit is null then
    return false;
  end if;

  insert into ai_usage as u (user_id, day, action, count)
  values (v_uid, current_date, p_action, 1)
  on conflict (user_id, day, action) do update
    set count = u.count + 1
    where u.count < v_limit;

  -- FOUND is false when the conflict update's WHERE rejected the row (limit reached).
  return found;
end;
$$;

revoke execute on function consume_ai_quota(text) from public, anon;
grant execute on function consume_ai_quota(text) to authenticated;

-- Per-user settings (one row per user)
create table if not exists user_settings (
  user_id uuid primary key default auth.uid() references auth.users,
  ai_notice_seen_at timestamptz,
  password_set_at timestamptz
);

alter table user_settings enable row level security;

drop policy if exists "Users manage their own settings" on user_settings;
create policy "Users manage their own settings"
  on user_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- The latest Insights result, one row per person, so it reloads with no AI call
create table if not exists insights (
  user_id uuid primary key default auth.uid() references auth.users,
  result jsonb not null,
  created_at timestamptz not null default now()
);

alter table insights enable row level security;

drop policy if exists "Users manage their own insights" on insights;
create policy "Users manage their own insights"
  on insights for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
