-- ══════════════════════════════════════════════════════════
-- Sip Tracker — Supabase schema
--
-- Run this in the Supabase SQL Editor (Project → SQL Editor →
-- "New query") to set up the cloud-sync tables and RLS.
--
-- After running this, in the Supabase Dashboard go to
--   Authentication → URL Configuration
-- and add your app's URL (the one your PWA is served from) to
-- the "Redirect URLs" allow-list, e.g.
--   https://you.github.io/sip-tracker/
--   http://localhost:8080/
-- Otherwise magic-link clicks land on an "invalid redirect" page.
--
-- Email provider settings live under
--   Authentication → Providers → Email
-- "Enable Email provider" must be on; "Confirm email" can be off
-- since we only use magic-link sign-in (no passwords).
-- ══════════════════════════════════════════════════════════

-- ── drinks ─────────────────────────────────────────────────
-- One row per drink the user has logged. Client generates the
-- UUID, server stores it as-is so syncs idempotently upsert.
create table if not exists public.drinks (
  id         text        primary key,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  type       text        not null check (type in ('beer', 'wine', 'liquor')),
  timestamp  timestamptz not null
);

create index if not exists drinks_user_idx       on public.drinks (user_id);
create index if not exists drinks_user_time_idx  on public.drinks (user_id, timestamp);

alter table public.drinks enable row level security;

drop policy if exists "drinks_select_own" on public.drinks;
drop policy if exists "drinks_insert_own" on public.drinks;
drop policy if exists "drinks_update_own" on public.drinks;
drop policy if exists "drinks_delete_own" on public.drinks;

create policy "drinks_select_own" on public.drinks
  for select using (auth.uid() = user_id);
create policy "drinks_insert_own" on public.drinks
  for insert with check (auth.uid() = user_id);
create policy "drinks_update_own" on public.drinks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "drinks_delete_own" on public.drinks
  for delete using (auth.uid() = user_id);


-- ── settings ───────────────────────────────────────────────
-- One row per user. The whole settings blob is stored as JSONB
-- so we can evolve the shape (new fields, etc.) without schema
-- changes. updated_at drives last-write-wins on conflicts.
create table if not exists public.settings (
  user_id     uuid        primary key references auth.users(id) on delete cascade,
  data        jsonb       not null,
  updated_at  timestamptz not null default now()
);

alter table public.settings enable row level security;

drop policy if exists "settings_select_own" on public.settings;
drop policy if exists "settings_insert_own" on public.settings;
drop policy if exists "settings_update_own" on public.settings;

create policy "settings_select_own" on public.settings
  for select using (auth.uid() = user_id);
create policy "settings_insert_own" on public.settings
  for insert with check (auth.uid() = user_id);
create policy "settings_update_own" on public.settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
