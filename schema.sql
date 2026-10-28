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

-- ===== v2: 일정 + 알림 (2026-10-29) =====
create table if not exists public.pds_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  date date not null,
  start_time text,            -- 'HH:MM' (비우면 종일)
  end_time text,
  title text not null,
  area text not null default 'life',
  memo text not null default '',
  remind text not null default 'none',   -- none | 0 | 10 | 30 | 60 | 1440 | eve
  remind_at timestamptz,                 -- 알림 시각 (앱이 계산)
  reminded_at timestamptz,               -- 푸시 보낸 시각 (중복 방지)
  done boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pds_events_user_date on public.pds_events (user_id, date);
create index if not exists pds_events_due on public.pds_events (remind_at) where reminded_at is null;

-- 웹푸시 구독 (기기별). 런닝 캘린더 push_subscriptions 와 분리: 그 함수가 이 앱 기기로 런닝 알림을 보내지 않도록
create table if not exists public.pds_push_subs (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  primary key (user_id, endpoint)
);

-- 루틴 알림 예약 (블록 시작 · 아침 Plan · 하루 리뷰 · 집중 타이머). 앱이 14일치를 만들어 둔다.
create table if not exists public.pds_push_queue (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null,
  kind text not null,          -- block | plan | review | focus
  date date,
  fire_at timestamptz not null,
  title text not null,
  body text not null default '',
  url text not null default './',
  sent_at timestamptz,         -- 보낸 시각 (중복 방지)
  primary key (user_id, key)
);
create index if not exists pds_push_queue_due on public.pds_push_queue (fire_at) where sent_at is null;

alter table public.pds_events enable row level security;
alter table public.pds_push_subs enable row level security;
alter table public.pds_push_queue enable row level security;
drop policy if exists "own pds_events" on public.pds_events;
create policy "own pds_events" on public.pds_events for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own pds_push_subs" on public.pds_push_subs;
create policy "own pds_push_subs" on public.pds_push_subs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own pds_push_queue" on public.pds_push_queue;
create policy "own pds_push_queue" on public.pds_push_queue for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
grant select, insert, update, delete on public.pds_events, public.pds_push_subs, public.pds_push_queue to authenticated;

-- 1분마다 pds-push Edge Function 호출 (CRON_SECRET 은 Edge Function 시크릿과 같은 값)
-- select cron.schedule('pds-push', '* * * * *', $$ select net.http_post(
--   url := 'https://gcnfvcbatpohhctitnkl.supabase.co/functions/v1/pds-push',
--   headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<CRON_SECRET>'),
--   body := '{}'::jsonb, timeout_milliseconds := 20000) $$);
