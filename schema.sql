-- PDS 플래너 Supabase 스키마 (런닝 캘린더 프로젝트에 함께 생성)
-- Supabase Dashboard > SQL Editor 에서 실행하세요.

create table if not exists public.pds_profile (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.pds_days (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

create table if not exists public.pds_weeks (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  week_start date not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, week_start)
);

alter table public.pds_profile enable row level security;
alter table public.pds_days enable row level security;
alter table public.pds_weeks enable row level security;

drop policy if exists "own pds_profile" on public.pds_profile;
create policy "own pds_profile" on public.pds_profile for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own pds_days" on public.pds_days;
create policy "own pds_days" on public.pds_days for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own pds_weeks" on public.pds_weeks;
create policy "own pds_weeks" on public.pds_weeks for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update, delete on public.pds_profile, public.pds_days, public.pds_weeks to authenticated;
