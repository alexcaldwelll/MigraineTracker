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
