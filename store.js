// 데이터 저장소: Supabase(클라우드) 또는 localStorage(로컬)
// 테이블: pds_profile(설정 1행) · pds_days(하루 1행) · pds_weeks(주 1행) — 모두 jsonb 문서
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const isCloud = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
let sb = null;
let uid = null;

/* ---------- local ---------- */
const LKEY = 'pds-planner-v1';
function lload() {
  let d; try { d = JSON.parse(localStorage.getItem(LKEY)) || {}; } catch { d = {}; }
  d.profile ||= null; d.days ||= {}; d.weeks ||= {};
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

/* ---------- 백업 ---------- */
export async function exportAll() {
  if (!isCloud) return { exported_at: now(), app: 'pds-planner', ...lload() };
  const profile = await getProfile();
  const days = chk(await sb.from('pds_days').select('date,data').order('date'));
  const weeks = chk(await sb.from('pds_weeks').select('week_start,data').order('week_start'));
  return { exported_at: now(), app: 'pds-planner', profile, days, weeks };
}
export async function importAll(j) {
  if (j.profile) await saveProfile(j.profile);
  const days = Array.isArray(j.days) ? j.days : Object.entries(j.days || {}).map(([date, data]) => ({ date, data }));
  for (const d of days) await saveDay(d.date, d.data);
  const weeks = Array.isArray(j.weeks) ? j.weeks : Object.entries(j.weeks || {}).map(([week_start, data]) => ({ week_start, data }));
  for (const w of weeks) await saveWeek(w.week_start, w.data);
}
