// 데이터 저장소: Supabase(클라우드) 또는 localStorage(로컬)
// 테이블: pds_profile(설정 1행) · pds_days(하루 1행) · pds_weeks(주 1행) — 모두 jsonb 문서
import { SUPABASE_URL, SUPABASE_ANON_KEY, READING_URL, READING_KEY } from './config.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const isCloud = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
let sb = null;
let uid = null;

/* ---------- local ---------- */
const LKEY = 'pds-planner-v1';
function lload() {
  let d; try { d = JSON.parse(localStorage.getItem(LKEY)) || {}; } catch { d = {}; }
  d.profile ||= null; d.days ||= {}; d.weeks ||= {}; d.events ||= [];
  return d;
}
function lsave(d) { localStorage.setItem(LKEY, JSON.stringify(d)); }

/* ---------- auth ---------- */
export function init() {
  if (!isCloud) return;
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
}
export async function getUser() {
  if (!isCloud) return { id: 'local', email: '로컬 모드' };
  const { data } = await sb.auth.getSession();
  uid = data.session?.user?.id ?? null;
  return data.session?.user ?? null;
}
export async function signIn(email, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error; uid = data.user.id; return data.user;
}
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
  if (error) throw error; uid = data.user?.id ?? null; return data;
}
export async function signOut() { if (isCloud) await sb.auth.signOut(); uid = null; }
export async function sendPasswordReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + '/?reset=1' });
  if (error) throw error;
}
export async function updatePassword(pw) { const { error } = await sb.auth.updateUser({ password: pw }); if (error) throw error; }
export function onAuth(cb) { if (isCloud) sb.auth.onAuthStateChange((e, s) => cb(e, s?.user ?? null)); }

function chk({ data, error }) { if (error) throw error; return data; }
const now = () => new Date().toISOString();

/* ---------- profile ---------- */
export async function getProfile() {
  if (!isCloud) return lload().profile;
  const r = chk(await sb.from('pds_profile').select('data').maybeSingle());
  return r?.data ?? null;
}
export async function saveProfile(data) {
  if (!isCloud) { const d = lload(); d.profile = data; lsave(d); return; }
  chk(await sb.from('pds_profile').upsert({ user_id: uid, data, updated_at: now() }));
}

/* ---------- days ---------- */
export async function getDay(date) {
  if (!isCloud) return lload().days[date] ?? null;
  const r = chk(await sb.from('pds_days').select('data').eq('date', date).maybeSingle());
  return r?.data ?? null;
}
export async function listDays(from, to) {
  if (!isCloud) {
    const d = lload().days;
    return Object.keys(d).filter(k => k >= from && k <= to).sort().map(k => ({ date: k, data: d[k] }));
  }
  return chk(await sb.from('pds_days').select('date,data').gte('date', from).lte('date', to).order('date'));
}
export async function saveDay(date, data) {
  if (!isCloud) { const d = lload(); d.days[date] = data; lsave(d); return; }
  chk(await sb.from('pds_days').upsert({ user_id: uid, date, data, updated_at: now() }, { onConflict: 'user_id,date' }));
}

/* ---------- weeks (week_start = 월요일) ---------- */
export async function getWeek(weekStart) {
  if (!isCloud) return lload().weeks[weekStart] ?? null;
  const r = chk(await sb.from('pds_weeks').select('data').eq('week_start', weekStart).maybeSingle());
  return r?.data ?? null;
}
export async function saveWeek(weekStart, data) {
  if (!isCloud) { const d = lload(); d.weeks[weekStart] = data; lsave(d); return; }
  chk(await sb.from('pds_weeks').upsert({ user_id: uid, week_start: weekStart, data, updated_at: now() }, { onConflict: 'user_id,week_start' }));
}

export async function listWeeks(from, to) {
  if (!isCloud) { const w = lload().weeks; return Object.keys(w).filter(k => k >= from && k <= to).sort().map(k => ({ week_start: k, data: w[k] })); }
  return chk(await sb.from('pds_weeks').select('week_start,data').gte('week_start', from).lte('week_start', to).order('week_start'));
}

/* ---------- months (month = 'YYYY-MM') : 월간 계획 ---------- */
export async function getMonth(month) {
  if (!isCloud) return lload().months?.[month] ?? null;
  const r = chk(await sb.from('pds_months').select('data').eq('month', month).maybeSingle());
  return r?.data ?? null;
}
export async function saveMonth(month, data) {
  if (!isCloud) { const d = lload(); d.months ||= {}; d.months[month] = data; lsave(d); return; }
  chk(await sb.from('pds_months').upsert({ user_id: uid, month, data, updated_at: now() }, { onConflict: 'user_id,month' }));
}

/* ---------- 일정 (pds_events: 블록과 별도 저장 → 근무표 변경·템플릿 재생성에 영향 없음) ---------- */
const EV_COLS = ['date', 'start_time', 'end_time', 'title', 'area', 'memo', 'remind', 'remind_at', 'reminded_at', 'done'];
const evRow = ev => Object.fromEntries(EV_COLS.map(k => [k, ev[k] ?? (k === 'done' ? false : k === 'memo' ? '' : null)]));
export async function listEvents(from, to) {
  if (!isCloud) return lload().events.filter(e => e.date >= from && e.date <= to);
  return chk(await sb.from('pds_events').select('id,' + EV_COLS.join(',')).gte('date', from).lte('date', to).order('date'));
}
export async function saveEvent(ev) {
  const row = { ...evRow(ev), updated_at: now() };
  if (!isCloud) {
    const d = lload(); const saved = { ...row, id: ev.id || 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
    d.events = d.events.filter(e => e.id !== saved.id).concat(saved); lsave(d); return saved;
  }
  if (ev.id) return chk(await sb.from('pds_events').update(row).eq('id', ev.id).select('id,' + EV_COLS.join(',')).single());
  return chk(await sb.from('pds_events').insert({ ...row, user_id: uid }).select('id,' + EV_COLS.join(',')).single());
}
export async function deleteEvent(id) {
  if (!isCloud) { const d = lload(); d.events = d.events.filter(e => e.id !== id); lsave(d); return; }
  chk(await sb.from('pds_events').delete().eq('id', id));
}

/* ---------- 웹푸시: 기기 구독 + 루틴 알림 예약 큐 (발송은 Edge Function pds-push 가 1분마다) ---------- */
export async function savePushSub(j, ua) {
  chk(await sb.from('pds_push_subs').upsert({ user_id: uid, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: ua || null }, { onConflict: 'user_id,endpoint' }));
}
export async function deletePushSub(endpoint) { chk(await sb.from('pds_push_subs').delete().eq('endpoint', endpoint)); }
export async function countPushSubs() {
  const { count, error } = await sb.from('pds_push_subs').select('endpoint', { count: 'exact', head: true });
  if (error) throw error; return count || 0;
}
/** 아직 안 보낸 미래 루틴 알림(집중 타이머 제외)을 지우고 새로 넣는다. 이미 보낸 key 는 그대로(중복 방지) */
export async function replacePushQueue(items) {
  chk(await sb.from('pds_push_queue').delete().is('sent_at', null).gte('fire_at', now()).neq('kind', 'focus'));
  if (!items.length) return;
  chk(await sb.from('pds_push_queue').upsert(items.map(x => ({ ...x, user_id: uid })), { onConflict: 'user_id,key', ignoreDuplicates: true }));
}
export async function queuePush(item) {
  chk(await sb.from('pds_push_queue').upsert({ ...item, user_id: uid, sent_at: null }, { onConflict: 'user_id,key' }));
}
export async function unqueuePush(key) { chk(await sb.from('pds_push_queue').delete().eq('key', key).is('sent_at', null)); }
export async function pendingPushCount() {
  const { count, error } = await sb.from('pds_push_queue').select('key', { count: 'exact', head: true }).is('sent_at', null).gte('fire_at', now());
  if (error) throw error; return count || 0;
}
export async function sendTestPush() {
  const { data, error } = await sb.functions.invoke('pds-push', { body: { test: true } });
  if (error) throw error; return data;
}

/* ---------- 런닝 캘린더 연동 (읽기 전용) ---------- */
export async function runningFor(from, to) {
  if (!isCloud) return [];
  try {
    const { data, error } = await sb.from('workouts')
      .select('date,type,title,planned_distance,target_pace,details,status,actual_distance,actual_time')
      .gte('date', from).lte('date', to).order('date');
    if (error) return [];
    return data || [];
  } catch { return []; }
}
export async function nextRace(today) {
  if (!isCloud) return null;
  try {
    const { data, error } = await sb.from('races').select('name,date,goal_time,priority')
      .gte('date', today).order('date').limit(5);
    if (error || !data?.length) return null;
    return data.find(r => r.priority === 'A') || data[0];
  } catch { return null; }
}

/* ---------- 독서앱 연동 (별도 프로젝트, 읽기 전용) ---------- */
let rb = null;
export const hasReading = Boolean(READING_URL && READING_KEY);
export function initReading() {
  if (hasReading) rb = createClient(READING_URL, READING_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pds-reading-auth' } });
}
export async function readingUser() {
  if (!rb) return null;
  const { data } = await rb.auth.getSession();
  return data.session?.user ?? null;
}
export async function readingConnect(email, password) {
  const { data, error } = await rb.auth.signInWithPassword({ email, password });
  if (error) throw error; return data.user;
}
export async function readingDisconnect() { if (rb) await rb.auth.signOut(); }
/** from~to(YYYY-MM-DD, 로컬 날짜) 범위의 독서 데이터 */
export async function readingData(from, to) {
  if (!rb) return null;
  const u = await readingUser(); if (!u) return null;
  const iso = (s, end) => new Date(s + (end ? 'T23:59:59' : 'T00:00:00')).toISOString();
  const [b, s, a, r] = await Promise.all([
    rb.from('books').select('id,title,author,cover_url,pages,current_page,status,start_date,finish_date').order('updated_at', { ascending: false }),
    rb.from('reading_sessions').select('book_id,started_at,seconds,start_page,end_page').gte('started_at', iso(from)).lte('started_at', iso(to, true)),
    rb.from('action_experiments').select('id,book_id,action,start_date,checks'),
    rb.from('review_tasks').select('book_id,stage,due_date,done').eq('done', false).lte('due_date', to),
  ]);
  const err = b.error || s.error || a.error || r.error;
  if (err) throw err;
  return { email: u.email, books: b.data || [], sessions: s.data || [], actions: a.data || [], reviews: r.data || [] };
}

/* ---------- 백업 ---------- */
export async function exportAll() {
  if (!isCloud) return { exported_at: now(), app: 'pds-planner', ...lload() };
  const profile = await getProfile();
  const days = chk(await sb.from('pds_days').select('date,data').order('date'));
  const weeks = chk(await sb.from('pds_weeks').select('week_start,data').order('week_start'));
  const events = chk(await sb.from('pds_events').select('id,' + EV_COLS.join(',')).order('date'));
  const months = chk(await sb.from('pds_months').select('month,data').order('month'));
  return { exported_at: now(), app: 'pds-planner', profile, days, weeks, months, events };
}
export async function importAll(j) {
  if (j.profile) await saveProfile(j.profile);
  const days = Array.isArray(j.days) ? j.days : Object.entries(j.days || {}).map(([date, data]) => ({ date, data }));
  for (const d of days) await saveDay(d.date, d.data);
  const weeks = Array.isArray(j.weeks) ? j.weeks : Object.entries(j.weeks || {}).map(([week_start, data]) => ({ week_start, data }));
  for (const w of weeks) await saveWeek(w.week_start, w.data);
  const months = Array.isArray(j.months) ? j.months : Object.entries(j.months || {}).map(([month, data]) => ({ month, data }));
  for (const m of months) await saveMonth(m.month, m.data);
  const have = new Set((await listEvents('0000-01-01', '9999-12-31')).map(e => e.id));
  for (const e of j.events || []) await saveEvent({ ...e, id: have.has(e.id) ? e.id : undefined, reminded_at: null });
}
