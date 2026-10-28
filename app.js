// 더원 PDS 플래너 — Plan(계획) · Do(실행) · See(리뷰)
import * as db from './store.js';
import { AREAS, defaultProfile, DEFAULT_TEMPLATE, DEFAULT_CAVEMAN, DEFAULT_SNS, SCORE_HELP } from './data.js';
import { VAPID_PUBLIC_KEY } from './config.js';

/* ================= utils ================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const dow = s => parse(s).getDay();
const isWeekend = s => [0, 6].includes(dow(s));
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const weekStart = s => { const w = dow(s); return addDays(s, w === 0 ? -6 : 1 - w); };
const toMin = t => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).slice(0, 8);
const fmtDate = s => { const d = parse(s); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`; };
const pct = v => v == null ? '–' : Math.round(v * 100) + '%';
const areaDot = a => `<span class="dot" style="background:${AREAS[a]?.color || '#999'}"></span>`;
const areaOpts = sel => Object.entries(AREAS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.label}</option>`).join('');

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

/* ================= state ================= */
const S = {
  user: null, profile: null, tab: 'home', seeView: 'day', home: null,
  date: today(), day: null, prev: null, week: null, nextWeek: null,
  runs: [], race: null, range: [], saving: false,
  events: [], evKey: null, modal: null, push: { sub: false, devices: null, pending: null, msg: '' },
};
const dirty = new Set();
let saveTimer = null;

function markDirty(scope) {
  dirty.add(scope);
  setSaveState('저장 중…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 700);
}
async function flush() {
  clearTimeout(saveTimer);
  const jobs = [...dirty]; dirty.clear();
  if (!jobs.length) return;
  try {
    for (const j of jobs) {
      if (j === 'day') await db.saveDay(S.date, S.day);
      if (j === 'week') await db.saveWeek(weekStart(S.date), S.week);
      if (j === 'nextWeek') await db.saveWeek(addDays(weekStart(S.date), 7), S.nextWeek);
      if (j === 'profile') await db.saveProfile(S.profile);
    }
    setSaveState('저장됨 ✓');
    if (jobs.includes('day') || jobs.includes('profile')) schedulePushSync();
  } catch (e) {
    jobs.forEach(j => dirty.add(j));
    setSaveState('저장 실패 — 다시 시도');
    toast('저장 실패: ' + (e.message || e));
  }
}
function setSaveState(t) { const el = $('#savestate'); if (el) el.textContent = t; }
window.addEventListener('beforeunload', e => { if (dirty.size) { flush(); e.preventDefault(); } });
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

/* ================= model ================= */
function mergeProfile(p) {
  const d = defaultProfile();
  if (!p) return d;
  return { ...d, ...p, links: { ...d.links, ...(p.links || {}) }, race: { ...d.race, ...(p.race || {}) }, work: { ...(p.work || {}) }, notify: { ...d.notify, ...(p.notify || {}) } };
}
/* ---------- 근무표: 평일=근무, 주말=휴무가 기본, profile.work[YYYY-MM-DD] = 'work' | 'off' 로 날짜별 지정 ---------- */
const defaultWork = date => (isWeekend(date) ? 'off' : 'work');
const workMode = date => S.profile?.work?.[date] || defaultWork(date);
const isWorkSet = date => !!S.profile?.work?.[date];
/** 평일(월) 템플릿의 출근·업무 구간과 그 안의 블록 (출근 이동 ~ 퇴근) */
function workWindow(template) {
  const mon = template.filter(t => t.days.includes(1));
  const core = mon.filter(t => t.area === 'work' || /출근/.test(t.title));
  if (!core.length) return null;
  const s = Math.min(...core.map(t => toMin(t.start))); const e = Math.max(...core.map(t => toMin(t.end)));
  return { s, e, blocks: mon.filter(t => toMin(t.start) >= s && toMin(t.end) <= e) };
}
function blocksFor(date, template) {
  const w = dow(date);
  let list = template.filter(t => t.days.includes(w));
  const mode = workMode(date); const win = workWindow(template);
  if (win) {
    const winIds = new Set(win.blocks.map(t => t.id));
    const hasWork = list.some(t => t.area === 'work');
    if (mode === 'work' && !hasWork) {
      // 주말 근무: 출근~퇴근 시간에 겹치는 블록(런닝 제외)을 빼고 평일 출근·업무 블록을 넣는다
      list = list.filter(t => t.area === 'run' || toMin(t.end) <= win.s || toMin(t.start) >= win.e).concat(win.blocks);
    } else if (mode === 'off' && hasWork) {
      list = list.filter(t => !winIds.has(t.id) && t.area !== 'work');
    }
  }
  return list.map(t => ({ id: uid(), tid: t.id, start: t.start, end: t.end, title: t.title, area: t.area, note: t.note || '', status: '' }))
    .sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(b.end) - toMin(a.end));
}
/** 저장된 날의 근무 구분이 바뀌었고 아직 체크한 블록이 없으면 블록을 다시 만든다 */
function syncWork(day, date) {
  const mode = workMode(date);
  if ((day.workMode ?? defaultWork(date)) === mode) { day.workMode = mode; return false; }
  if (day.blocks.some(b => b.status)) return false;
  day.blocks = blocksFor(date, S.profile.template); day.workMode = mode; return true;
}
function newDay(date) {
  return {
    v: 1, intention: '', workMode: workMode(date),
    blocks: blocksFor(date, S.profile.template),
    top3: [{ text: '', area: 'biz', done: false }, { text: '', area: 'run', done: false }, { text: '', area: 'read', done: false }],
    tasks: [], caveman: {}, sns: {}, reading: {}, review: {}, focus: [],
  };
}
function normDay(d, date) {
  const n = newDay(date);
  if (!d) return n;
  return { ...n, ...d, top3: d.top3?.length ? d.top3 : n.top3 };
}
const newWeek = () => ({ goals: { run: '', read: '', biz: '' }, goalsDone: {}, review: {} });
const normWeek = w => ({ ...newWeek(), ...(w || {}), goals: { ...newWeek().goals, ...(w?.goals || {}) } });

function cavemanItems(date) { return S.profile.caveman.filter(c => !c.weekend || isWeekend(date)); }
function snsItems(date) { return S.profile.sns.filter(s => s.days.includes(dow(date))); }

/** 하루 점수: 각 항목 0~1, total = 값이 있는 항목 평균 */
function score(day, date) {
  if (!day) return null;
  const r = {};
  const bl = day.blocks || [];
  if (bl.length) {
    const v = bl.reduce((a, b) => a + (b.status === 'done' ? 1 : b.status === 'partial' ? 0.5 : 0), 0);
    r.blocks = { v, n: bl.length, p: v / bl.length, checked: bl.filter(b => b.status).length };
  }
  const items = cavemanItems(date);
  const y = items.filter(c => day.caveman?.[c.no] === true).length;
  const touched = items.some(c => c.no in (day.caveman || {}));
  r.cave = { v: y, n: items.length, p: touched || y ? y / items.length : 0, touched };
  const t3 = (day.top3 || []).filter(t => t.text.trim());
  if (t3.length) r.top3 = { v: t3.filter(t => t.done).length, n: t3.length, p: t3.filter(t => t.done).length / t3.length };
  const sns = snsItems(date);
  if (sns.length) {
    const ps = sns.map(s => Math.min(1, (Number(day.sns?.[s.key]) || 0) / (s.target || 1)));
    r.sns = { p: ps.reduce((a, b) => a + b, 0) / ps.length };
  }
  const parts = [r.blocks?.p, r.cave?.p, r.top3?.p, r.sns?.p].filter(v => v != null);
  r.total = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  return r;
}
const scoreColor = p => p == null ? 'var(--empty)' : p >= 0.8 ? '#16a34a' : p >= 0.6 ? '#65a30d' : p >= 0.4 ? '#ca8a04' : p > 0 ? '#ea580c' : 'var(--empty)';

/* ================= load ================= */
async function loadDate(date) {
  await flush();
  if (S.home && S.day) S.home.map[S.date] = S.day;
  S.date = date;
  const ws = weekStart(date);
  const [day, prev, week, nextWeek, runs] = await Promise.all([
    db.getDay(date), db.getDay(addDays(date, -1)), db.getWeek(ws), db.getWeek(addDays(ws, 7)),
    db.runningFor(ws, addDays(ws, 6)), loadReading(date), loadEvents(),
  ]);
  S.day = normDay(day, date);
  if (day && syncWork(S.day, date)) markDirty('day');
  S.prev = prev;
  S.week = normWeek(week);
  S.nextWeek = normWeek(nextWeek);
  S.runs = runs;
  render();
}

/* ================= render: shell ================= */
function render() {
  const app = $('#app');
  if (!S.user) { app.innerHTML = loginView(); return; }
  readEvForm();
  const sc = score(S.day, S.date);
  const isToday = S.date === today();
  const dd = S.race ? Math.round((parse(S.race.date) - parse(today())) / 864e5) : null;
  app.innerHTML = `
  <header class="top">
    <div class="brand">더원 <b>PDS</b></div>
    <div class="datenav">
      <button data-act="date" data-d="-1" aria-label="이전 날">‹</button>
      <button class="datelabel ${isToday ? 'is-today' : ''}" data-act="pickdate">${fmtDate(S.date)}${isToday ? '' : ' · 오늘로'}</button>
      <button data-act="date" data-d="1" aria-label="다음 날">›</button>
      <input type="date" id="datepick" value="${S.date}" hidden />
    </div>
    <div class="hdr-right">
      ${dd != null && dd >= 0 ? `<span class="dday" title="${esc(S.race.name)} ${esc(S.race.goal)}">D-${dd}</span>` : ''}
      <span class="scorebadge" style="background:${scoreColor(sc?.total)}" title="${SCORE_HELP}">${sc?.total != null ? Math.round(sc.total * 100) : '–'}</span>
    </div>
  </header>
  ${phaseBanner()}
  <main id="view" class="${S.tab === 'home' ? 'wide' : ''}">${S.tab === 'home' ? homeView() : S.tab === 'plan' ? planView() : S.tab === 'do' ? doView() : S.tab === 'see' ? seeView() : settingsView()}</main>
  <div class="savestate" id="savestate"></div>
  <nav class="tabs">
    ${[['home', '⌂', '홈'], ['plan', 'P', '계획'], ['do', 'D', '실행'], ['see', 'S', '리뷰'], ['set', '⚙', '설정']].map(([k, i, l]) =>
      `<button data-act="tab" data-tab="${k}" class="${S.tab === k ? 'on' : ''}"><b>${i}</b><span>${l}</span></button>`).join('')}
  </nav>
  ${focusOverlay()}${modalView()}`;
  if (S.tab === 'see') afterSeeRender();
  if (S.tab === 'set') refreshPushState();
}

function phaseBanner() {
  if (S.date !== today()) return '';
  const m = nowMin();
  const rv = toMin(S.profile.reviewTime || '21:30');
  const reviewed = !!S.day.review?.at;
  if (m >= rv - 10 && !reviewed) return `<div class="banner see" data-act="tab" data-tab="see">🌙 리뷰 시간이에요 — 하루 리뷰(See) 10분 하기 ›</div>`;
  if (m < toMin('08:20') && !(S.day.top3 || []).some(t => t.text.trim())) return `<div class="banner plan" data-act="tab" data-tab="plan">☀️ 오늘의 핵심 3을 먼저 정해요 (Plan) ›</div>`;
  return '';
}

/* ================= HOME (대시보드) ================= */
const PH = { plan: { k: 'P', l: '계획' }, do: { k: 'D', l: '실행' }, see: { k: 'S', l: '리뷰' } };
const phaseOpts = sel => Object.entries(PH).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v.k} ${v.l}</option>`).join('');
const sum = a => a.reduce((x, y) => x + (Number(y) || 0), 0);

function monthBounds(date) {
  const first = date.slice(0, 8) + '01';
  const d = parse(first); d.setMonth(d.getMonth() + 1); d.setDate(0);
  return { first, last: ymd(d) };
}
/** 달력 칸: 점수 색 + 런닝/리뷰 표시 */
function calCells(first, last, map, runs, act) {
  const start = parse(first).getDay(); const lastD = parse(last).getDate();
  const cells = []; const vals = [];
  for (let i = 0; i < (start + 6) % 7; i++) cells.push('<div></div>');
  for (let i = 1; i <= lastD; i++) {
    const dt = first.slice(0, 8) + pad(i);
    const sc = score(map[dt], dt); if (sc?.total != null) vals.push(sc.total);
    const run = runs.find(r => r.date === dt && r.status === 'done');
    const planned = !run && runs.find(r => r.date === dt && r.status === 'planned' && !/휴식|rest/i.test(r.type + r.title));
    const wm = workMode(dt);
    const wx = wm === 'work' && isWeekend(dt) ? '<b class="wk-x">출</b>' : wm === 'off' && !isWeekend(dt) ? '<b class="wk-x off">휴</b>' : '';
    const evs = eventsOn(dt); const evOpen = evs.filter(e => !e.done).length;
    cells.push(`<button class="mday ${dt === S.date ? 'sel' : ''} ${dt === today() ? 'today' : ''} ${wm === 'work' ? 'wk' : ''}" data-act="${act}" data-d="${dt}" style="background:${scoreColor(sc?.total)}" title="${dt}${sc?.total != null ? ' PDS ' + Math.round(sc.total * 100) : ''}${evs.length ? ' · 일정 ' + evs.map(e => e.title).join(', ') : ''}">
      ${wx}${evs.length ? `<i class="evc ${evOpen ? '' : 'alldone'}">${evs.length}</i>` : ''}<span>${i}</span>${sc?.total != null ? `<b>${Math.round(sc.total * 100)}</b>` : ''}${run ? '<i>🏃</i>' : planned ? '<i class="pl">·</i>' : ''}${map[dt]?.review?.at ? '<i class="rv">✍</i>' : ''}${sessionsOn(dt).length ? '<i class="rd">📖</i>' : ''}</button>`);
  }
  return { cells, vals };
}
function workPill(date) {
  const m = workMode(date); const win = workWindow(S.profile.template);
  const hrs = win ? (() => { const w = win.blocks.find(t => t.area === 'work'); return w ? ` ${w.start}~${w.end}` : ''; })() : '';
  return m === 'work' ? `<span class="pill work">💼 근무${hrs}</span>` : `<span class="pill off">🌿 휴무</span>`;
}
function workSummary(first, last) {
  let w = 0, o = 0;
  for (let dt = first; dt <= last; dt = addDays(dt, 1)) (workMode(dt) === 'work' ? w++ : o++);
  return `근무 ${w}일 · 휴무 ${o}일`;
}
/** 설정: 근무표 달력 (누를 때마다 근무 ↔ 휴무) */
function workSettings() {
  const base = S.workMonth || S.date.slice(0, 7);
  const { first, last } = monthBounds(base + '-01');
  const start = parse(first).getDay();
  const cells = [];
  for (let i = 0; i < (start + 6) % 7; i++) cells.push('<div></div>');
  for (let dt = first; dt <= last; dt = addDays(dt, 1)) {
    const m = workMode(dt); const set = isWorkSet(dt); const exc = m !== defaultWork(dt);
    cells.push(`<button class="wday ${m} ${exc ? 'exc' : ''} ${set ? 'set' : ''}" data-act="workcycle" data-d="${dt}" title="${dt} ${m === 'work' ? '근무' : '휴무'}${set ? '' : ' (기본값)'}">
      <span>${Number(dt.slice(8))}</span><small>${m === 'work' ? '근무' : '휴무'}</small></button>`);
  }
  const setN = Object.keys(S.profile.work || {}).filter(k => k >= first && k <= last).length;
  return `<section class="card">
    <div class="calhead"><button class="icon" data-act="workmonth" data-n="-1">‹</button>
      <h3>💼 근무표 · ${parse(first).getFullYear()}년 ${parse(first).getMonth() + 1}월</h3>
      <button class="icon" data-act="workmonth" data-n="1">›</button></div>
    <p class="muted small">날짜를 누를 때마다 근무 ↔ 휴무. 지정 안 한 날은 평일 근무 · 주말 휴무(점선). 주말 근무일에는 출근·업무 블록이, 평일 휴무일에는 업무 블록이 빠진 하루가 자동으로 만들어져요.</p>
    <div class="mgrid head">${['월', '화', '수', '목', '금', '토', '일'].map(x => `<div>${x}</div>`).join('')}</div>
    <div class="mgrid">${cells.join('')}</div>
    <p class="small"><b>${workSummary(first, last)}</b> ${setN ? `<span class="muted">· 직접 지정 ${setN}일</span>` : '<span class="muted">· 아직 기본값</span>'}</p>
    <div class="btnrow"><button data-act="workfill" data-m="${base}">이 달 기본값으로 확정</button>
      <button class="ghost" data-act="workclear" data-m="${base}">이 달 지정 지우기</button></div>
  </section>`;
}
function homeKey() { const { first, last } = monthBounds(S.date); const ws = weekStart(S.date); return [first, last, ws].join('|'); }
async function loadHome() {
  const key = homeKey();
  if (S.homeLoading === key) return;
  S.homeLoading = key;
  const { first, last } = monthBounds(S.date);
  const ws = weekStart(S.date); const we = addDays(ws, 6);
  const from = ws < first ? ws : first; const to = we > last ? we : last;
  try {
    const [rows, runs] = await Promise.all([db.listDays(from, to), db.runningFor(from, to)]);
    S.home = { key, map: Object.fromEntries(rows.map(r => [r.date, r.data])), runs };
  } catch { S.home = { key, map: {}, runs: [] }; }
  S.homeLoading = null;
  if (S.tab === 'home' && !S.modal) render();
}

function homeView() {
  if (S.home?.key !== homeKey()) { loadHome(); }
  const H = S.home?.key === homeKey() ? S.home : { map: {}, runs: [], loading: true };
  const map = { ...H.map, [S.date]: S.day };
  const d = S.day; const sc = score(d, S.date);
  const ws = weekStart(S.date); const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const { first, last } = monthBounds(S.date);
  const { cells, vals } = calCells(first, last, map, H.runs, 'pick');
  const monthAvg = vals.length ? sum(vals) / vals.length : null;
  const isToday = S.date === today();
  const cur = isToday ? currentBlocks().cur : null;
  const items = cavemanItems(S.date); const caveY = items.filter(c => d.caveman[c.no] === true).length;
  return `
  <section class="summary">
    <div class="sumhead"><h2>${isToday ? '오늘' : fmtDate(S.date)} 한눈에 보기 ${workPill(S.date)}</h2>
      ${cur ? `<span class="nowpill" style="--c:${AREAS[cur.area]?.color}">지금 · ${esc(cur.title)} ~${cur.end}</span>` : ''}</div>
    <div class="kpis">
      <div><b style="color:${scoreColor(sc?.total)}">${sc?.total != null ? Math.round(sc.total * 100) : '–'}</b><span>PDS 점수</span></div>
      <div><b>${pct(sc?.blocks?.p)}</b><span>블록 실행</span></div>
      <div><b>${caveY}/${items.length}</b><span>원시인 버튼</span></div>
      <div><b>${sc?.top3 ? `${sc.top3.v}/${sc.top3.n}` : '–'}</b><span>핵심 3</span></div>
      <div><b>${d.review?.at ? '✓' : '–'}</b><span>하루 리뷰</span></div>
    </div>
    ${d.intention ? `<p class="intent">🎯 ${esc(d.intention)}</p>` : ''}
  </section>

  ${upcomingCard()}

  <div class="dash">
    <section class="card calcard">
      <div class="calhead">
        <button class="icon" data-act="monthnav" data-n="-1" aria-label="이전 달">‹</button>
        <h3>📅 ${parse(first).getFullYear()}년 ${parse(first).getMonth() + 1}월</h3>
        <button class="icon" data-act="monthnav" data-n="1" aria-label="다음 달">›</button>
      </div>
      <div class="mgrid head">${['월', '화', '수', '목', '금', '토', '일'].map(x => `<div>${x}</div>`).join('')}</div>
      <div class="mgrid">${cells.join('')}</div>
      <p class="muted small">${H.loading ? '불러오는 중… · ' : ''}월 평균 PDS ${pct(monthAvg)} · ${workSummary(first, last)} · 🏃 런닝 완료 · ✍ 리뷰 · <i class="evc leg">2</i> 일정 수 · <span class="wk-leg"></span> 근무일 · <b class="wk-x">출</b> 주말 근무 · <b class="wk-x off">휴</b> 평일 휴무</p>
      ${dayEventsBlock(S.date)}
    </section>
    <div class="areas">
      ${runArea(H, days)}${readArea()}${snsArea(map, days)}${bizArea(map, days)}
    </div>
  </div>

  ${pdsBoard()}`;
}

function runArea(H, days) {
  const wk = (H.loading ? S.runs : H.runs).filter(r => r.date >= days[0] && r.date <= days[6]);
  const train = wk.filter(r => !/휴식|rest/i.test(r.type + r.title));
  const done = train.filter(r => r.status === 'done');
  const km = sum(done.map(r => r.actual_distance ?? r.planned_distance));
  const planKm = sum(train.map(r => r.planned_distance));
  const td = wk.filter(r => r.date === S.date);
  const dd = S.race ? Math.round((parse(S.race.date) - parse(today())) / 864e5) : null;
  const block = S.day.blocks.find(b => b.area === 'run');
  return `<section class="card area" style="--c:${AREAS.run.color}">
    <div class="ahead"><h3>🏃 런닝</h3>${S.race && dd >= 0 ? `<span class="dday">D-${dd}</span>` : ''}</div>
    <div class="abig">${td.length ? td.map(r => `${esc(r.title)}${r.planned_distance ? ` <small>${r.planned_distance}km</small>` : ''} <span class="pill ${r.status}">${r.status === 'done' ? '완료' : r.status === 'skipped' ? '건너뜀' : '예정'}</span>`).join('<br>') : `<span class="muted">${block ? esc(block.title) + ' (루틴)' : '훈련 없음'}</span>`}</div>
    <div class="aline"><span>이번 주</span><b>${done.length}/${train.length}회</b><span>${km ? km.toFixed(1) : 0}${planKm ? '/' + planKm.toFixed(0) : ''}km</span></div>
    <div class="bar sm"><i style="width:${planKm ? Math.min(100, km / planKm * 100) : 0}%"></i></div>
    ${S.race ? `<p class="muted small">${esc(S.race.name)} · 목표 ${esc(S.race.goal)}</p>` : ''}
    <a class="linkbtn small" href="${esc(S.profile.links.runningApp)}" target="_blank" rel="noopener">런닝 캘린더 ↗</a>
  </section>`;
}
function readArea() {
  const p = S.profile;
  const { first, last } = monthBounds(S.date);
  const monthBooks = doneBooks(first, last).length;
  const readCnt = p.tracks.filter(t => trackRead(t, S.date)).length;
  const ws = weekStart(S.date);
  const todayMin = readMinutes(S.date, S.date); const weekMin = readMinutes(ws, addDays(ws, 6));
  const linkedIds = new Set(p.tracks.map(t => t.bookId).filter(Boolean));
  const loose = (S.reading?.books || []).filter(b => b.status === 'reading' && !linkedIds.has(b.id));
  return `<section class="card area" style="--c:${AREAS.read.color}">
    <div class="ahead"><h3>📚 독서</h3><span class="muted small">오늘 ${readCnt}/4 트랙${S.reading ? ` · ${todayMin}분` : ''}</span></div>
    <div class="aline"><span>이번 달 완독</span><b>${monthBooks}/${p.monthlyBooks}권</b>${S.reading ? `<span>주간 ${weekMin}분</span>` : ''}</div>
    <div class="bar sm"><i style="width:${Math.min(100, monthBooks / (p.monthlyBooks || 1) * 100)}%"></i></div>
    <ul class="mini">${p.tracks.map(t => {
      const tb = trackBook(t); const on = trackRead(t, S.date);
      const pr = tb.total ? Math.min(1, (tb.page || 0) / tb.total) : 0;
      return `<li><span class="chk ${on ? 'on' : ''}" data-act="readtoggle" data-id="${t.id}" title="오늘 읽음">${on ? '✓' : ''}</span>
        <span class="tn">${esc(t.name)}</span><span class="bk ellipsis">${tb.title ? esc(tb.title) : '<span class="muted">책 미정</span>'}</span>
        <span class="pc">${tb.total ? Math.round(pr * 100) + '%' : ''}</span></li>`;
    }).join('')}</ul>
    ${loose.length ? `<p class="muted small">트랙 미지정: ${loose.map(b => esc(b.title)).join(', ')} · <a href="#" data-act="gotab" data-tab="plan">Plan에서 지정</a></p>` : ''}
    ${readingStatusLine()}
  </section>`;
}
function snsArea(map, days) {
  const d = S.day; const items = snsItems(S.date);
  const wk = days.map(dt => score(map[dt], dt)?.sns?.p).filter(v => v != null && v > 0);
  return `<section class="card area" style="--c:#ec4899">
    <div class="ahead"><h3>📣 SNS</h3><span class="muted small">주간 평균 ${wk.length ? pct(sum(wk) / wk.length) : '–'}</span></div>
    ${items.map(s => {
      const v = Number(d.sns[s.key]) || 0; const p = Math.min(1, v / (s.target || 1));
      return `<div class="snsmini"><span>${esc(s.label)}</span>
        <div class="bar sm"><i style="width:${p * 100}%;background:${p >= 1 ? '#16a34a' : '#ec4899'}"></i></div>
        <b>${s.target === 1 ? (v ? '✓' : '–') : `${v}/${s.target}`}</b>
        ${s.target === 1 ? `<button class="sm" data-act="snsset" data-k="${s.key}" data-v="${v ? 0 : 1}">${v ? '취소' : '완료'}</button>` : `<button class="sm" data-act="sns" data-k="${s.key}" data-n="1">+1</button>`}</div>`;
    }).join('')}
  </section>`;
}
function bizArea(map, days) {
  const d = S.day;
  const blocks = d.blocks.filter(b => b.area === 'biz');
  const tasks = [...d.top3.filter(t => t.text.trim() && t.area === 'biz'), ...d.tasks.filter(t => t.area === 'biz')];
  const focusMin = sum(days.flatMap(dt => (map[dt]?.focus || []).filter(f => f.area === 'biz' || /글쓰기|사업/.test(f.title)).map(f => f.min)));
  const goal = S.week.goals.biz;
  const icon = s => s === 'done' ? '✓' : s === 'partial' ? '△' : s === 'skip' ? '✕' : '○';
  return `<section class="card area" style="--c:${AREAS.biz.color}">
    <div class="ahead"><h3>💼 온라인사업</h3><span class="muted small">이번 주 집중 ${focusMin}분</span></div>
    ${blocks.length ? blocks.map(b => `<div class="aline"><span class="st-${b.status || 'none'}">${icon(b.status)}</span><span class="grow">${b.start} ${esc(b.title)}</span></div>`).join('') : '<p class="muted small">오늘 사업 블록 없음</p>'}
    <div class="aline"><span>사업 할 일</span><b>${tasks.filter(t => t.done).length}/${tasks.length}</b></div>
    <p class="small">${goal ? `주간 목표: ${esc(goal)} ${S.week.goalsDone?.biz ? '✅' : ''}` : '<span class="muted">주간 사업 목표 없음 (Plan에서 입력)</span>'}</p>
    <p class="muted small">스레드 · 인스타 · 전자책(AI각인독서법, 미라클모닝 7단계)</p>
  </section>`;
}

/** P·D·S 할 일 보드: 자동 항목(앱 상태로 체크) + 직접 추가한 할 일 */
function pdsBoard() {
  const d = S.day; const isToday = S.date === today(); const m = nowMin();
  const t3 = d.top3.filter(t => t.text.trim()).length;
  const lesson = S.prev?.review?.change?.trim();
  const goalsN = ['run', 'read', 'biz'].filter(a => S.week.goals[a]?.trim()).length;
  const noBook = S.profile.tracks.filter(t => !trackBook(t).title).length;
  const acts = activeActions(S.date);
  const dues = dueReviews(S.date);
  const rUrl = S.profile.links.readingApp;
  const autoP = [
    { text: `오늘의 핵심 3 정하기 (${t3}/3)`, done: t3 >= 3, tab: 'plan' },
    { text: `이번 주 3대 영역 목표 (${goalsN}/3)`, done: goalsN >= 3, tab: 'plan' },
    lesson && { text: `어제의 Try 반영: ${lesson}`, done: d.tasks.some(t => t.text === lesson), tab: 'plan' },
    noBook && { text: `독서 트랙 책 정하기 (${4 - noBook}/4)`, done: false, tab: 'plan' },
  ].filter(Boolean);
  const pastOpen = d.blocks.filter(b => (!isToday || toMin(b.end) <= m) && !b.status).length;
  const caveTouched = Object.keys(d.caveman).length > 0;
  const snsAny = Object.values(d.sns).some(v => Number(v) > 0);
  const autoS = [
    { text: pastOpen ? `타임라인 체크 (남은 ${pastOpen}개)` : '타임라인 체크', done: !pastOpen && d.blocks.some(b => b.status), tab: 'do' },
    { text: '원시인 버튼 스캔', done: caveTouched, tab: 'do' },
    { text: 'SNS 카운터 입력', done: snsAny, tab: 'do' },
    { text: `하루 리뷰 (${S.profile.reviewTime})`, done: !!d.review?.at, tab: 'see' },
    dow(S.date) === 0 && { text: '주간 리뷰 + 다음 주 목표', done: !!(S.week.review?.good || S.week.review?.change), tab: 'see', see: 'week' },
    ...dues.map(r => ({ text: `📖 독서 복습 ${r.stage}: ${r.title}${r.due_date < S.date ? ' (밀림)' : ''}`, done: false, url: rUrl })),
  ].filter(Boolean);
  const autoLi = it => `<li class="auto ${it.done ? 'done' : ''}" ${it.url ? `data-act="openurl" data-url="${esc(it.url)}"` : `data-act="gotab" data-tab="${it.tab}" data-see="${it.see || ''}"`}>
      <span class="chk ${it.done ? 'on' : ''}">${it.done ? '✓' : ''}</span><span class="grow">${esc(it.text)}</span><span class="go">›</span></li>`;
  const taskLi = (t, i) => `<li class="${t.done ? 'done' : ''}"><label><input type="checkbox" data-act="toggletask" data-i="${i}" ${t.done ? 'checked' : ''} />
      ${areaDot(t.area)}<span class="grow">${esc(t.text)}</span></label><button class="icon" data-act="deltask" data-i="${i}" title="삭제">✕</button></li>`;
  const mine = ph => d.tasks.map((t, i) => [t, i]).filter(([t]) => (t.phase || 'do') === ph);
  const topLi = d.top3.map((t, i) => t.text.trim() ? `<li class="${t.done ? 'done' : ''}"><label><input type="checkbox" data-act="toggletop" data-i="${i}" ${t.done ? 'checked' : ''} />
      ${areaDot(t.area)}<span class="grow"><b>핵심</b> ${esc(t.text)}</span></label></li>` : '').join('');
  const runs = S.runs.filter(r => r.date === S.date && !/휴식|rest/i.test(r.type + r.title));
  const runLi = runs.map(r => `<li class="auto ${r.status === 'done' ? 'done' : ''}" data-act="gotab" data-tab="do"><span class="chk ${r.status === 'done' ? 'on' : ''}">${r.status === 'done' ? '✓' : ''}</span>
      <span class="grow">🏃 ${esc(r.title)}${r.planned_distance ? ` ${r.planned_distance}km` : ''}</span><span class="go">›</span></li>`).join('');
  const evs = eventsOn(S.date);
  const evLi = evs.map(e => `<li class="${e.done ? 'done' : ''}"><label><input type="checkbox" data-act="evdone" data-id="${e.id}" ${e.done ? 'checked' : ''} />
      ${areaDot(e.area)}<span class="grow">📌 ${evTime(e)} ${esc(e.title)}</span></label><button class="icon" data-act="evedit" data-id="${e.id}" title="일정 수정">✎</button></li>`).join('');
  const col = (ph, title, autoHtml, extra = '') => {
    const mt = mine(ph);
    const all = [...(ph === 'plan' ? autoP : ph === 'see' ? autoS : []), ...mt.map(([t]) => t)];
    const doneN = all.filter(x => x.done).length + (ph === 'do' ? d.top3.filter(t => t.text.trim() && t.done).length + runs.filter(r => r.status === 'done').length + acts.filter(a => a.done).length + evs.filter(e => e.done).length : 0);
    const totalN = all.length + (ph === 'do' ? t3 + runs.length + acts.length + evs.length : 0);
    return `<section class="card pcol pc-${ph}">
      <div class="phead"><b class="ph ph-${ph}">${PH[ph].k}</b><h3>${title}</h3><span class="muted small">${doneN}/${totalN}</span></div>
      <ul class="todo">${autoHtml}${extra}${mt.map(([t, i]) => taskLi(t, i)).join('')}</ul>
      ${!totalN ? '<p class="muted small">비어 있어요</p>' : ''}
      <input class="addph" data-ph="${ph}" placeholder="+ ${PH[ph].l} 할 일 추가 (Enter)" />
    </section>`;
  };
  return `<div class="pdscols">
    ${col('plan', '계획', autoP.map(autoLi).join(''))}
    ${col('do', '실행', evLi + topLi + runLi + acts.map(a => autoLi({ text: `🧪 실행 실험 D${a.day}/30: ${a.action}`, done: a.done, url: rUrl })).join(''))}
    ${col('see', '리뷰', autoS.map(autoLi).join(''))}
  </div>`;
}

/* ================= 독서앱 연동 ================= */
async function loadReading(date) {
  if (!db.hasReading) return;
  const { first, last } = monthBounds(date);
  const ws = weekStart(date); const we = addDays(ws, 6);
  const from = ws < first ? ws : first; const to = we > last ? we : last;
  try { S.reading = await db.readingData(from, to); S.readingErr = null; }
  catch (e) { S.reading = null; S.readingErr = e.message || String(e); }
}
const rBook = id => S.reading?.books.find(b => b.id === id);
/** 트랙의 책: 독서앱 책이 연결돼 있으면 그 데이터, 아니면 직접 입력값 */
function trackBook(t) {
  const b = t.bookId && rBook(t.bookId);
  if (b) return { title: b.title, total: b.pages || 0, page: b.current_page || 0, linked: true, b };
  return { title: t.book, total: t.total || 0, page: t.page || 0, linked: false };
}
const sessDate = s => ymd(new Date(s.started_at));
function sessionsOn(date, bookId) { return (S.reading?.sessions || []).filter(s => sessDate(s) === date && (!bookId || s.book_id === bookId)); }
function trackRead(t, date) {
  if (date === S.date && S.day.reading[t.id]) return true;
  return !!(t.bookId && sessionsOn(date, t.bookId).length);
}
function readMinutes(from, to, bookId) {
  return Math.round((S.reading?.sessions || []).filter(s => { const d = sessDate(s); return d >= from && d <= to && (!bookId || s.book_id === bookId); })
    .reduce((a, s) => a + (s.seconds || 0), 0) / 60);
}
/** 완독: PDS 직접 기록 + 독서앱 status=done (제목 중복 제거) */
function doneBooks(from, to) {
  const list = S.profile.books.filter(b => b.date >= from && b.date <= to).map(b => ({ title: b.title, date: b.date, track: b.track }));
  for (const b of S.reading?.books || []) {
    if (b.status === 'done' && b.finish_date && b.finish_date >= from && b.finish_date <= to && !list.some(x => x.title === b.title)) {
      const t = S.profile.tracks.find(x => x.bookId === b.id);
      list.push({ title: b.title, date: b.finish_date, track: t ? t.name : '독서앱' });
    }
  }
  return list;
}
function activeActions(date) {
  return (S.reading?.actions || []).map(a => {
    const day = Math.round((parse(date) - parse(a.start_date)) / 864e5) + 1;
    return { ...a, day, done: !!a.checks?.[date] };
  }).filter(a => a.day >= 1 && a.day <= 30);
}
function dueReviews(date) {
  return (S.reading?.reviews || []).filter(r => r.due_date <= date).map(r => ({ ...r, title: rBook(r.book_id)?.title || '책' }));
}
function readingStatusLine() {
  if (!db.hasReading) return '';
  if (S.reading) return `<p class="muted small">🔗 독서앱 연동됨 · <a href="${esc(S.profile.links.readingApp)}" target="_blank" rel="noopener">독서앱 열기 ↗</a></p>`;
  return `<p class="small"><a href="#" data-act="gotab" data-tab="set">🔗 독서앱 연결하기 ›</a> <span class="muted">책·쪽수·독서 시간 자동 불러오기</span></p>`;
}
const bookOpts = sel => `<option value="">직접 입력</option>` + (S.reading?.books || []).filter(b => b.status !== 'done' || b.id === sel)
  .map(b => `<option value="${b.id}" ${b.id === sel ? 'selected' : ''}>${esc(b.title)}${b.status === 'want' ? ' (읽을 책)' : b.status === 'done' ? ' (완독)' : ''}</option>`).join('');

/* ================= PLAN ================= */
function planView() {
  const d = S.day; const p = S.profile;
  const lesson = S.prev?.review?.change?.trim();
  const ws = weekStart(S.date);
  return `
  <section class="card">
    <h2>📋 Plan · ${fmtDate(S.date)} ${isWeekend(S.date) ? '<span class="pill">주말</span>' : '<span class="pill">평일</span>'} ${workPill(S.date)}</h2>
    ${lesson ? `<div class="lesson"><div><small>어제 리뷰에서 정한 '내일 바꿀 1가지'</small><p>${esc(lesson)}</p></div>
      <button class="sm" data-act="lesson2task">할 일로 추가</button></div>` : ''}
    <label class="lbl">오늘의 의도 (한 줄)</label>
    <input data-bind="day.intention" value="${esc(d.intention)}" placeholder="예: 골든타임에 스레드 글 3개 초안 끝내기" />
  </section>

  <section class="card">
    <div class="ahead"><h3>📌 일정 <small>블록과 별도 저장 · 근무표·템플릿을 바꿔도 그대로</small></h3>
      <button class="sm primary" data-act="evnew" data-d="${S.date}">+ 일정 추가</button></div>
    ${evList(eventsOn(S.date), { empty: '이 날 일정이 없어요.' })}
  </section>

  <section class="card">
    <h3>🎯 오늘의 핵심 3 <small>3대 영역에서 하나씩 권장</small></h3>
    ${d.top3.map((t, i) => `
      <div class="row">
        <select data-bind="day.top3.${i}.area" class="areasel">${areaOpts(t.area)}</select>
        <input data-bind="day.top3.${i}.text" value="${esc(t.text)}" placeholder="${['사업: 예) 전자책 상세페이지 수정', '런닝: 예) 인터벌 8×400m', '독서: 예) 사피엔스 40쪽'][i] || ''}" />
      </div>`).join('')}
  </section>

  <section class="card">
    <h3>🗓 이번 주 목표 <small>${fmtDate(ws)} 주</small></h3>
    ${['run', 'read', 'biz'].map(a => `
      <div class="row">${areaDot(a)}<b class="w4">${AREAS[a].label}</b>
        <input data-bind="week.goals.${a}" value="${esc(S.week.goals[a])}" placeholder="이번 주 ${AREAS[a].label} 목표" /></div>`).join('')}
  </section>

  <section class="card">
    <h3>⏱ 시간 블록 <small>루틴 템플릿에서 자동 생성 · 오늘만 수정</small></h3>
    <div class="blocks-edit">
    ${d.blocks.map((b, i) => `
      <div class="bedit" style="--c:${AREAS[b.area]?.color}">
        <input type="time" data-bind="day.blocks.${i}.start" value="${b.start}" />
        <input type="time" data-bind="day.blocks.${i}.end" value="${b.end}" />
        <input data-bind="day.blocks.${i}.title" value="${esc(b.title)}" class="grow" />
        <select data-bind="day.blocks.${i}.area" class="areasel">${areaOpts(b.area)}</select>
        <button class="icon" data-act="delblock" data-i="${i}" title="삭제">✕</button>
      </div>`).join('')}
    </div>
    <div class="btnrow">
      <button data-act="addblock">+ 블록 추가</button>
      <button data-act="sortblocks">시간순 정렬</button>
      <button class="ghost" data-act="resetblocks">템플릿으로 다시 만들기</button>
    </div>
  </section>

  <section class="card">
    <h3>✅ 할 일</h3>
    ${taskList(true)}
    <div class="row">
      <select id="newtaskphase" class="areasel">${phaseOpts('do')}</select>
      <select id="newtaskarea" class="areasel">${areaOpts('biz')}</select>
      <input id="newtask" placeholder="할 일 입력 후 Enter" />
      <button data-act="addtask">추가</button>
    </div>
  </section>

  <section class="card">
    <h3>📚 독서 트랙 계획 <small>책 · 쪽수 · 실행 과제 (리뷰/토론은 별도 대화창)</small></h3>
    ${readingStatusLine()}
    ${p.tracks.map((t, i) => { const tb = trackBook(t); return `
      <div class="track-edit">
        <div class="row"><b class="w8">${esc(t.name)}</b>
          ${S.reading ? `<select data-bind="profile.tracks.${i}.bookId" class="grow">${bookOpts(t.bookId)}</select>` : ''}
          ${tb.linked ? `<span class="muted small">${tb.page || 0}/${tb.total || '?'}쪽</span>` : `<input data-bind="profile.tracks.${i}.book" value="${esc(t.book)}" placeholder="읽는 책" class="grow" />
          <input type="number" min="0" data-bind="profile.tracks.${i}.total" value="${t.total || ''}" placeholder="총쪽" class="w5" />`}</div>
        <div class="row"><span class="w8 muted">실행 과제</span>
          <input data-bind="profile.tracks.${i}.action" value="${esc(t.action)}" placeholder="책에서 가져온 행동 1개" class="grow" />
          <button class="sm" data-act="action2task" data-i="${i}" ${t.action ? '' : 'disabled'}>오늘 할 일로</button></div>
      </div>`; }).join('')}
    <p class="muted">독서 기록·리뷰는 <a href="${esc(p.links.readingApp)}" target="_blank" rel="noopener">독서앱</a>에서. 여기서는 진행 체크와 실행 과제 연결만 합니다.</p>
  </section>`;
}

function taskList(editable) {
  const d = S.day;
  if (!d.tasks.length) return `<p class="muted">할 일이 없어요.</p>`;
  return `<ul class="tasks">${d.tasks.map((t, i) => `
    <li class="${t.done ? 'done' : ''}">
      <label><input type="checkbox" data-act="toggletask" data-i="${i}" ${t.done ? 'checked' : ''} /> <i class="ph ph-${t.phase || 'do'}">${PH[t.phase || 'do'].k}</i> ${areaDot(t.area)} <span>${esc(t.text)}</span></label>
      ${editable ? `<span class="taskbtns"><button class="icon" data-act="movetask" data-i="${i}" title="내일로 미루기">→</button><button class="icon" data-act="deltask" data-i="${i}" title="삭제">✕</button></span>` : ''}
    </li>`).join('')}</ul>`;
}

/* ================= DO ================= */
function currentBlocks() {
  const m = nowMin();
  const bl = S.day.blocks;
  const cur = bl.filter(b => toMin(b.start) <= m && m < toMin(b.end)).sort((a, b) => (toMin(a.end) - toMin(a.start)) - (toMin(b.end) - toMin(b.start)))[0];
  const next = bl.filter(b => toMin(b.start) > m).sort((a, b) => toMin(a.start) - toMin(b.start))[0];
  return { cur, next };
}
function nowCard() {
  if (S.date !== today()) return '';
  const { cur, next } = currentBlocks();
  const m = nowMin();
  if (!cur) return `<section class="card now"><div class="nowlabel">지금</div><h2>자유 시간</h2>
    ${next ? `<p class="muted">다음: ${next.start} ${esc(next.title)} (${toMin(next.start) - m}분 후)</p>` : '<p class="muted">오늘 블록 끝 — 잘 쉬세요.</p>'}</section>`;
  const s = toMin(cur.start), e = toMin(cur.end);
  const p = Math.min(1, (m - s) / Math.max(1, e - s));
  const i = S.day.blocks.indexOf(cur);
  return `<section class="card now" style="--c:${AREAS[cur.area]?.color}">
    <div class="nowlabel">지금 · ${cur.start}–${cur.end}</div>
    <h2>${areaDot(cur.area)} ${esc(cur.title)}</h2>
    ${cur.note ? `<p class="muted">${esc(cur.note)}</p>` : ''}
    <div class="bar"><i style="width:${p * 100}%"></i></div>
    <p class="muted">${e - m}분 남음${next ? ` · 다음 ${next.start} ${esc(next.title)}` : ''}</p>
    <div class="btnrow">
      <button class="primary" data-act="focus" data-i="${i}">⏳ 집중 타이머</button>
      <button data-act="bstatus" data-i="${i}" data-s="done">✓ 완료</button>
    </div></section>`;
}
function runCard() {
  const p = S.profile;
  const runs = S.runs.filter(r => r.date === S.date);
  const runBlock = S.day.blocks.find(b => b.area === 'run');
  const dd = S.race ? Math.round((parse(S.race.date) - parse(today())) / 864e5) : null;
  return `<section class="card">
    <h3>🏃 오늘 런닝 ${S.race && dd >= 0 ? `<small>${esc(S.race.name)} D-${dd} · 목표 ${esc(S.race.goal)}</small>` : ''}</h3>
    ${runs.length ? runs.map(r => `<div class="runrow">
        <b>${esc(r.title)}</b> ${r.planned_distance ? `<span class="pill">${r.planned_distance}km</span>` : ''} ${r.target_pace ? `<span class="pill">@${esc(r.target_pace)}</span>` : ''}
        <span class="pill ${r.status}">${r.status === 'done' ? '완료' : r.status === 'skipped' ? '건너뜀' : '계획'}</span>
        ${r.details ? `<p class="muted">${esc(r.details)}</p>` : ''}</div>`).join('')
      : `<p class="muted">${db.isCloud ? '런닝 캘린더에 오늘 훈련이 없어요.' : '로컬 모드에서는 런닝 캘린더 연동이 꺼져 있어요.'} ${runBlock ? `루틴: ${esc(runBlock.title)}` : ''}</p>`}
    <a class="linkbtn" href="${esc(p.links.runningApp)}" target="_blank" rel="noopener">런닝 캘린더에서 기록하기 ↗</a>
  </section>`;
}
function doView() {
  const d = S.day;
  const sc = score(d, S.date);
  const m = nowMin(); const isToday = S.date === today();
  const items = cavemanItems(S.date);
  const y = items.filter(c => d.caveman[c.no] === true).length;
  const monthBooks = doneBooks(monthBounds(S.date).first, monthBounds(S.date).last).length;
  return `
  ${nowCard()}
  <section class="card">
    <h3>⏱ 타임라인 <small>${sc?.blocks ? `${sc.blocks.checked}/${sc.blocks.n} 체크 · 실행률 ${pct(sc.blocks.p)}` : ''}</small></h3>
    <ol class="timeline">
    ${timelineItems().map(({ b, i, e }) => {
      if (e) return `<li class="tl event ${e.done ? 'done' : ''}" style="--c:${AREAS[e.area]?.color || '#999'}">
        <span class="t">${e.start_time || '종일'}</span>
        <span class="ttl">📌 ${esc(e.title)} <i class="evtag">일정</i>${e.end_time ? ` <small class="muted">~${e.end_time}</small>` : ''}${e.memo ? `<small class="muted evmemo">${esc(e.memo)}</small>` : ''}</span>
        <span class="st">
          <button data-act="evtoggle" data-id="${e.id}" class="${e.done ? 'on' : ''}" title="완료">✓</button>
          <button data-act="evedit" data-id="${e.id}" title="수정">✎</button>
        </span></li>`;
      const past = isToday && toMin(b.end) <= m;
      const cur = isToday && toMin(b.start) <= m && m < toMin(b.end);
      return `<li class="tl ${b.status} ${past && !b.status ? 'needs' : ''} ${cur ? 'cur' : ''}" style="--c:${AREAS[b.area]?.color}">
        <span class="t">${b.start}</span>
        <span class="ttl">${esc(b.title)}${past && !b.status ? ' <em>체크 필요</em>' : ''}</span>
        <span class="st">
          <button data-act="bstatus" data-i="${i}" data-s="done" class="${b.status === 'done' ? 'on' : ''}" title="완료">✓</button>
          <button data-act="bstatus" data-i="${i}" data-s="partial" class="${b.status === 'partial' ? 'on' : ''}" title="부분">△</button>
          <button data-act="bstatus" data-i="${i}" data-s="skip" class="${b.status === 'skip' ? 'on' : ''}" title="못함">✕</button>
        </span></li>`;
    }).join('')}
    </ol>
    <div class="btnrow"><button class="sm" data-act="evnew" data-d="${S.date}">+ 일정 추가</button></div>
  </section>

  <section class="card">
    <h3>🎯 핵심 3</h3>
    ${d.top3.some(t => t.text.trim()) ? `<ul class="tasks">${d.top3.map((t, i) => t.text.trim() ? `<li class="${t.done ? 'done' : ''}"><label>
      <input type="checkbox" data-act="toggletop" data-i="${i}" ${t.done ? 'checked' : ''} /> ${areaDot(t.area)} <span>${esc(t.text)}</span></label></li>` : '').join('')}</ul>`
      : `<p class="muted">아직 없어요. <a href="#" data-act="tab" data-tab="plan">Plan에서 정하기 ›</a></p>`}
    <h3 class="mt">✅ 할 일</h3>
    ${taskList(false)}
  </section>

  ${runCard()}

  <section class="card">
    <h3>🔘 원시인 버튼 스캔 <small>${isWeekend(S.date) ? '주말 15점' : '평일 8점'} · Y가 아니면 자동 N</small></h3>
    <div class="cave">
      ${items.map(c => `<button class="cv ${d.caveman[c.no] === true ? 'y' : ''}" data-act="cave" data-no="${c.no}">
        <span class="no">${c.no}</span><b>${esc(c.name)}</b><small>${esc(c.hint)}</small><i>${d.caveman[c.no] === true ? 'Y' : 'N'}</i></button>`).join('')}
    </div>
    <div class="scoreline"><b>${y}</b> / ${items.length}점</div>
  </section>

  <section class="card">
    <h3>📣 SNS 체크리스트 <small>${sc?.sns ? '달성 ' + pct(sc.sns.p) : ''}</small></h3>
    ${snsItems(S.date).map(s => {
      const v = Number(d.sns[s.key]) || 0; const p = Math.min(1, v / (s.target || 1));
      return s.target === 1 ? `<div class="sns"><span class="lbl2">${esc(s.label)}</span>
          <button class="toggle ${v ? 'on' : ''}" data-act="snsset" data-k="${s.key}" data-v="${v ? 0 : 1}">${v ? '완료 ✓' : '미완료'}</button></div>`
        : `<div class="sns"><span class="lbl2">${esc(s.label)}</span>
          <div class="bar sm"><i style="width:${p * 100}%;background:${p >= 1 ? '#16a34a' : 'var(--accent)'}"></i></div>
          <span class="cnt"><b>${v}</b>/${s.target}</span>
          <button class="sm" data-act="sns" data-k="${s.key}" data-n="-1">−</button>
          <button class="sm" data-act="sns" data-k="${s.key}" data-n="1">+1</button>
          <button class="sm" data-act="sns" data-k="${s.key}" data-n="${s.target >= 20 ? 5 : 2}">+${s.target >= 20 ? 5 : 2}</button></div>`;
    }).join('')}
  </section>

  <section class="card">
    <h3>📚 병렬독서 4트랙 <small>이번 달 완독 ${monthBooks}/${S.profile.monthlyBooks}권${S.reading ? ` · 오늘 ${readMinutes(S.date, S.date)}분` : ''}</small></h3>
    ${readingStatusLine()}
    ${S.profile.tracks.map((t, i) => {
      const tb = trackBook(t);
      const p = tb.total ? Math.min(1, (tb.page || 0) / tb.total) : 0;
      const read = trackRead(t, S.date);
      const auto = t.bookId && sessionsOn(S.date, t.bookId).length;
      if (tb.linked) return `<div class="track">
        <div class="row"><b class="w8">${esc(t.name)}</b><span class="grow ellipsis">${esc(tb.title)}</span>
          ${auto ? `<span class="pill done">오늘 ${readMinutes(S.date, S.date, t.bookId)}분 ✓</span>` : `<button class="toggle sm ${read ? 'on' : ''}" data-act="readtoggle" data-id="${t.id}">${read ? '오늘 읽음 ✓' : '오늘 읽음'}</button>`}</div>
        <div class="row"><div class="bar sm grow"><i style="width:${p * 100}%"></i></div>
          <span class="muted">${tb.page || 0} / ${tb.total || '?'}쪽 (${Math.round(p * 100)}%)</span>
          <a class="small" href="${esc(S.profile.links.readingApp)}" target="_blank" rel="noopener">독서앱에서 기록 ↗</a></div>
        ${t.action ? `<div class="muted small">실행 과제: ${esc(t.action)}</div>` : ''}
      </div>`;
      return `<div class="track">
        <div class="row"><b class="w8">${esc(t.name)}</b><span class="grow ellipsis">${t.book ? esc(t.book) : '<span class="muted">책 미정 (Plan에서 입력)</span>'}</span>
          <button class="toggle sm ${read ? 'on' : ''}" data-act="readtoggle" data-id="${t.id}">${read ? '오늘 읽음 ✓' : '오늘 읽음'}</button></div>
        ${t.book ? `<div class="row"><div class="bar sm grow"><i style="width:${p * 100}%"></i></div>
          <input type="number" min="0" class="w5" data-bind="profile.tracks.${i}.page" data-track="${t.id}" value="${t.page || ''}" placeholder="쪽" />
          <span class="muted">/ ${t.total || '?'}쪽</span>
          <button class="sm" data-act="finish" data-i="${i}">완독</button></div>
          ${t.action ? `<div class="muted small">실행 과제: ${esc(t.action)}</div>` : ''}` : ''}
      </div>`;
    }).join('')}
  </section>`;
}

/* ================= SEE ================= */
function seeView() {
  return `<div class="seg">
    ${[['day', '하루'], ['week', '주간'], ['month', '월간']].map(([k, l]) => `<button data-act="seeview" data-v="${k}" class="${S.seeView === k ? 'on' : ''}">${l}</button>`).join('')}
  </div>
  ${S.seeView === 'day' ? seeDay() : `<div id="seebody"><p class="muted center">불러오는 중…</p></div>`}`;
}
function scoreRows(sc) {
  if (!sc) return '';
  const row = (l, v, extra) => `<div class="srow"><span>${l}</span><div class="bar sm grow"><i style="width:${(v ?? 0) * 100}%;background:${scoreColor(v)}"></i></div><b>${pct(v)}</b><small>${extra || ''}</small></div>`;
  return `${row('블록 실행', sc.blocks?.p, sc.blocks ? `${sc.blocks.v}/${sc.blocks.n}` : '')}
    ${row('원시인 버튼', sc.cave?.p, `${sc.cave.v}/${sc.cave.n}`)}
    ${sc.top3 ? row('핵심 3', sc.top3.p, `${sc.top3.v}/${sc.top3.n}`) : ''}
    ${sc.sns ? row('SNS', sc.sns.p, '') : ''}`;
}
function seeDay() {
  const d = S.day; const sc = score(d, S.date); const r = d.review || {};
  const skipped = d.blocks.filter(b => b.status === 'skip' || b.status === 'partial');
  const undone = d.top3.filter(t => t.text.trim() && !t.done);
  const readCnt = S.profile.tracks.filter(t => trackRead(t, S.date)).length;
  const runs = S.runs.filter(x => x.date === S.date);
  return `
  <section class="card">
    <h2>🔍 See · ${fmtDate(S.date)}</h2>
    <div class="bigscore" style="--c:${scoreColor(sc?.total)}"><b>${sc?.total != null ? Math.round(sc.total * 100) : '–'}</b><span>PDS 점수</span></div>
    ${scoreRows(sc)}
    <ul class="facts">
      <li>📚 독서 트랙 ${readCnt}/4 읽음${S.reading ? ` · 독서앱 기록 ${readMinutes(S.date, S.date)}분` : ''}</li>
      <li>🏃 런닝: ${runs.length ? runs.map(x => `${esc(x.title)} (${x.status === 'done' ? '완료' : x.status === 'skipped' ? '건너뜀' : '미기록'})`).join(', ') : '캘린더 훈련 없음'}</li>
      ${skipped.length ? `<li>⚠️ 못했거나 부분 실행: ${skipped.map(b => esc(b.title)).join(', ')}</li>` : ''}
      ${undone.length ? `<li>🎯 못 끝낸 핵심: ${undone.map(t => esc(t.text)).join(', ')}</li>` : ''}
    </ul>
    <p class="muted small">${SCORE_HELP}</p>
  </section>

  <section class="card">
    <h3>✍️ 하루 리뷰 (10분) ${r.at ? '<span class="pill done">작성됨</span>' : ''}</h3>
    <label class="lbl">오늘 에너지</label>
    <div class="energy">${[1, 2, 3, 4, 5].map(n => `<button data-act="energy" data-n="${n}" class="${r.energy === n ? 'on' : ''}">${n}</button>`).join('')}</div>
    <label class="lbl">잘된 것 (Keep)</label>
    <textarea data-bind="day.review.good" rows="2" placeholder="사실 위주로: 무엇을 했고 왜 잘 됐나">${esc(r.good)}</textarea>
    <label class="lbl">아쉬운 것과 원인 (Problem)</label>
    <textarea data-bind="day.review.bad" rows="2" placeholder="못한 블록의 원인: 시간? 에너지? 환경?">${esc(r.bad)}</textarea>
    <label class="lbl">내일 바꿀 1가지 (Try) <small>→ 내일 Plan 맨 위에 표시</small></label>
    <input data-bind="day.review.change" value="${esc(r.change)}" placeholder="작고 구체적인 행동 하나" />
    <label class="lbl">한 줄 일기</label>
    <input data-bind="day.review.line" value="${esc(r.line)}" placeholder="오늘을 한 문장으로" />
    <div class="btnrow">
      <button class="primary" data-act="reviewdone">리뷰 완료 → 내일 계획하기</button>
      ${dow(S.date) === 0 ? `<button data-act="seeview" data-v="week">주간 리뷰로</button>` : ''}
    </div>
  </section>`;
}

async function afterSeeRender() {
  if (S.seeView === 'day') return;
  const body = $('#seebody'); if (!body) return;
  const key = S.seeView + S.date;
  if (S.seeView === 'week') {
    const ws = weekStart(S.date); const we = addDays(ws, 6);
    const rows = await db.listDays(ws, we);
    if (key !== S.seeView + S.date || !$('#seebody')) return;
    $('#seebody').innerHTML = seeWeek(ws, rows);
  } else {
    const first = S.date.slice(0, 8) + '01';
    const d = parse(first); d.setMonth(d.getMonth() + 1); d.setDate(0);
    const last = ymd(d);
    const [rows, runs] = await Promise.all([db.listDays(first, last), db.runningFor(first, last)]);
    if (key !== S.seeView + S.date || !$('#seebody')) return;
    $('#seebody').innerHTML = seeMonth(first, last, rows, runs);
  }
}

function seeWeek(ws, rows) {
  const map = Object.fromEntries(rows.map(r => [r.date, r.data]));
  map[S.date] = S.day;
  const days = [...Array(7)].map((_, i) => addDays(ws, i));
  const scs = days.map(dt => ({ dt, sc: score(map[dt], dt), d: map[dt] }));
  const avg = (f) => { const v = scs.map(f).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const runsDone = S.runs.filter(r => r.status === 'done').length;
  const runsPlan = S.runs.filter(r => !/휴식|rest/i.test(r.type + r.title)).length;
  const books = doneBooks(ws, addDays(ws, 6));
  const reviews = scs.filter(x => x.d?.review?.at).length;
  const w = S.week; const r = w.review || {};
  const H = 120;
  const chart = `<svg viewBox="0 0 350 ${H + 34}" class="chart">
    ${[0.5, 1].map(g => `<line x1="0" x2="350" y1="${H - g * H + 4}" y2="${H - g * H + 4}" class="grid"/>`).join('')}
    ${scs.map((x, i) => {
      const v = x.sc?.total ?? 0; const h = Math.max(2, v * H);
      return `<rect x="${i * 50 + 10}" y="${H - h + 4}" width="30" height="${h}" rx="5" fill="${scoreColor(x.sc?.total)}"/>
      <text x="${i * 50 + 25}" y="${H - h}" class="cv">${x.sc?.total != null ? Math.round(v * 100) : ''}</text>
      <text x="${i * 50 + 25}" y="${H + 24}" class="lb ${x.dt === S.date ? 'sel' : ''}">${DOW[dow(x.dt)]}</text>`;
    }).join('')}</svg>`;
  return `
  <section class="card">
    <h2>📊 주간 See · ${fmtDate(ws)} ~ ${fmtDate(addDays(ws, 6))}</h2>
    ${chart}
    <div class="kpis">
      <div><b>${pct(avg(x => x.sc?.total))}</b><span>평균 PDS</span></div>
      <div><b>${pct(avg(x => x.sc?.blocks?.p))}</b><span>블록 실행</span></div>
      <div><b>${pct(avg(x => x.sc?.cave?.p))}</b><span>원시인 버튼</span></div>
      <div><b>${pct(avg(x => x.sc?.sns?.p))}</b><span>SNS</span></div>
      <div><b>${runsDone}/${runsPlan}</b><span>런닝 완료</span></div>
      <div><b>${books.length}</b><span>완독</span></div>
      <div><b>${reviews}/7</b><span>하루 리뷰</span></div>
    </div>
    <table class="wtable"><thead><tr><th></th>${days.map(dt => `<th>${DOW[dow(dt)]}</th>`).join('')}</tr></thead><tbody>
      <tr><td>원시인</td>${scs.map(x => `<td>${x.sc ? `${x.sc.cave.v}/${x.sc.cave.n}` : '–'}</td>`).join('')}</tr>
      <tr><td>블록</td>${scs.map(x => `<td>${x.sc?.blocks ? pct(x.sc.blocks.p) : '–'}</td>`).join('')}</tr>
      <tr><td>SNS</td>${scs.map(x => `<td>${x.sc?.sns ? pct(x.sc.sns.p) : '–'}</td>`).join('')}</tr>
      <tr><td>에너지</td>${scs.map(x => `<td>${x.d?.review?.energy ?? '–'}</td>`).join('')}</tr>
    </tbody></table>
  </section>

  <section class="card">
    <h3>🗓 이번 주 목표 달성</h3>
    ${['run', 'read', 'biz'].map(a => `<label class="goalchk">
      <input type="checkbox" data-act="goaldone" data-a="${a}" ${w.goalsDone?.[a] ? 'checked' : ''} ${w.goals[a] ? '' : 'disabled'} />
      ${areaDot(a)} <b>${AREAS[a].label}</b> ${w.goals[a] ? esc(w.goals[a]) : '<span class="muted">목표 없음</span>'}</label>`).join('')}
  </section>

  <section class="card">
    <h3>✍️ 주간 리뷰 <small>일요일 21:30</small></h3>
    <label class="lbl">이번 주 가장 잘한 것</label>
    <textarea data-bind="week.review.good" rows="2">${esc(r.good)}</textarea>
    <label class="lbl">막힌 것과 원인 (데이터 보고)</label>
    <textarea data-bind="week.review.bad" rows="2">${esc(r.bad)}</textarea>
    <label class="lbl">다음 주 바꿀 1가지</label>
    <input data-bind="week.review.change" value="${esc(r.change)}" />
    <h3 class="mt">➡️ 다음 주 목표 <small>${fmtDate(addDays(ws, 7))} 주 Plan에 자동 표시</small></h3>
    ${['run', 'read', 'biz'].map(a => `<div class="row">${areaDot(a)}<b class="w4">${AREAS[a].label}</b>
      <input data-bind="nextWeek.goals.${a}" value="${esc(S.nextWeek.goals[a])}" placeholder="다음 주 ${AREAS[a].label} 목표" /></div>`).join('')}
  </section>`;
}

function seeMonth(first, last, rows, runs) {
  const map = Object.fromEntries(rows.map(r => [r.date, r.data]));
  if (S.date >= first && S.date <= last) map[S.date] = S.day;
  const { cells, vals } = calCells(first, last, map, runs, 'goto');
  const books = doneBooks(first, last);
  const reviews = rows.filter(r => r.data?.review?.at).length;
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const caveAvg = (() => { const v = rows.map(r => score(r.data, r.date)?.cave?.p).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; })();
  return `<section class="card">
    <h2>📅 ${parse(first).getMonth() + 1}월 See</h2>
    <div class="kpis">
      <div><b>${pct(avg)}</b><span>평균 PDS</span></div>
      <div><b>${books.length}/${S.profile.monthlyBooks}</b><span>완독</span></div>
      <div><b>${runs.filter(r => r.status === 'done').length}</b><span>런닝 완료</span></div>
      <div><b>${pct(caveAvg)}</b><span>원시인 평균</span></div>
      <div><b>${reviews}</b><span>리뷰한 날</span></div>
    </div>
    <div class="mgrid head">${['월', '화', '수', '목', '금', '토', '일'].map(x => `<div>${x}</div>`).join('')}</div>
    <div class="mgrid">${cells.join('')}</div>
    <p class="muted small">색이 진할수록 PDS 점수가 높아요. 날짜를 누르면 그날로 이동합니다.</p>
    ${books.length ? `<h3 class="mt">이번 달 완독</h3><ul class="facts">${books.map(b => `<li>${esc(b.title)} <small class="muted">${esc(b.track)} · ${b.date.slice(5)}</small></li>`).join('')}</ul>` : ''}
  </section>`;
}

/* ================= SETTINGS ================= */
function settingsView() {
  const p = S.profile;
  return `
  <section class="card">
    <h2>⚙️ 설정</h2>
    <p>계정: <b>${esc(S.user.email)}</b> ${db.isCloud ? '<span class="pill">클라우드 동기화</span>' : '<span class="pill">로컬 모드</span>'}</p>
    <div class="btnrow">${db.isCloud ? '<button data-act="logout">로그아웃</button>' : ''}
      <button data-act="export">백업 내보내기 (JSON)</button>
      <label class="filebtn">백업 가져오기<input type="file" id="importfile" accept="application/json" hidden /></label></div>
  </section>

  <section class="card">
    <h3>🏁 목표 대회</h3>
    ${S.raceFromCal ? `<p class="muted small">런닝 캘린더의 대회가 우선 표시됩니다: ${esc(S.raceFromCal.name)} ${esc(S.raceFromCal.date)} ${esc(S.raceFromCal.goal_time || '')}</p>` : ''}
    <div class="row"><input data-bind="profile.race.name" value="${esc(p.race.name)}" class="grow" placeholder="대회명" />
      <input type="date" data-bind="profile.race.date" value="${esc(p.race.date)}" /></div>
    <div class="row"><input data-bind="profile.race.goal" value="${esc(p.race.goal)}" placeholder="목표 (예: 서브 3:40)" /></div>
  </section>

  <section class="card">
    <h3>🧱 루틴 템플릿 <small>요일 칩을 눌러 켜고 끄기 · 새 날짜부터 적용</small></h3>
    ${p.template.map((t, i) => `<div class="tpl" style="--c:${AREAS[t.area]?.color}">
      <div class="row"><input type="time" data-bind="profile.template.${i}.start" value="${t.start}" />
        <input type="time" data-bind="profile.template.${i}.end" value="${t.end}" />
        <input data-bind="profile.template.${i}.title" value="${esc(t.title)}" class="grow" />
        <select data-bind="profile.template.${i}.area" class="areasel">${areaOpts(t.area)}</select>
        <button class="icon" data-act="deltpl" data-i="${i}">✕</button></div>
      <div class="row chips">${[1, 2, 3, 4, 5, 6, 0].map(w => `<button class="chip ${t.days.includes(w) ? 'on' : ''}" data-act="tplday" data-i="${i}" data-w="${w}">${DOW[w]}</button>`).join('')}
        <input data-bind="profile.template.${i}.note" value="${esc(t.note)}" placeholder="메모" class="grow small" /></div>
    </div>`).join('')}
    <div class="btnrow"><button data-act="addtpl">+ 블록 추가</button><button data-act="sorttpl">시간순 정렬</button>
      <button class="ghost" data-act="resettpl">문서 기본값으로 되돌리기</button>
      <button class="ghost" data-act="applytpl">오늘 블록에 다시 적용</button></div>
  </section>

  ${notifySettings()}

  ${workSettings()}

  <section class="card">
    <h3>🔘 원시인 버튼 항목</h3>
    ${p.caveman.map((c, i) => `<div class="row"><span class="w3">${c.no}</span>
      <input data-bind="profile.caveman.${i}.name" value="${esc(c.name)}" class="w8" />
      <input data-bind="profile.caveman.${i}.hint" value="${esc(c.hint)}" class="grow" />
      <span class="pill">${c.weekend ? '주말' : '매일'}</span></div>`).join('')}
  </section>

  <section class="card">
    <h3>📣 SNS 목표</h3>
    ${p.sns.map((s, i) => `<div class="row"><b class="grow">${esc(s.label)}</b>
      <input type="number" min="1" class="w5" data-bind="profile.sns.${i}.target" value="${s.target}" /> <span>${esc(s.unit)}</span>
      <span class="muted small">${s.days.length === 7 ? '매일' : s.days.map(w => DOW[w]).join('·')}</span></div>`).join('')}
  </section>

  <section class="card">
    <h3>📚 독서</h3>
    <div class="row"><span class="grow">월 완독 목표</span><input type="number" min="1" class="w5" data-bind="profile.monthlyBooks" value="${p.monthlyBooks}" /> 권</div>
    ${p.tracks.map((t, i) => `<div class="row"><span class="w5 muted">트랙 ${i + 1}</span><input data-bind="profile.tracks.${i}.name" value="${esc(t.name)}" class="grow" /></div>`).join('')}
    <h3 class="mt">완독 기록</h3>
    ${p.books.length ? `<ul class="facts">${[...p.books].reverse().map(b => `<li>${esc(b.title)} <small class="muted">${esc(b.track)} · ${b.date}</small>
      <button class="icon" data-act="delbook" data-id="${b.id}">✕</button></li>`).join('')}</ul>` : '<p class="muted">아직 없어요.</p>'}
    <div class="row"><input id="bookadd" placeholder="완독한 책 직접 추가" class="grow" /><button data-act="addbook">추가</button></div>
  </section>

  ${db.hasReading ? `<section class="card" id="readingconnect">
    <h3>📖 독서앱 연동 <small>책·쪽수·독서 시간·완독·실행 실험·복습을 읽기 전용으로 불러옴</small></h3>
    ${S.reading ? `<p>연결됨: <b>${esc(S.reading.email)}</b> · 책 ${S.reading.books.length}권</p>
      <div class="btnrow"><button data-act="readrefresh">새로고침</button><button class="ghost" data-act="readdisconnect">연결 해제</button></div>
      <p class="muted small">트랙별 책 지정은 Plan 탭 '독서 트랙 계획'에서 합니다.</p>`
      : `<p class="muted small">독서앱 계정(이메일/비밀번호)으로 한 번 연결하면 이 기기에서 계속 유지됩니다.${S.readingErr ? ` (오류: ${esc(S.readingErr)})` : ''}</p>
      <div class="row"><input id="remail" type="email" placeholder="독서앱 이메일" value="${esc(S.user.email)}" class="grow" /></div>
      <div class="row"><input id="rpw" type="password" placeholder="독서앱 비밀번호" class="grow" autocomplete="current-password" /><button class="primary" data-act="readconnect">연결</button></div>`}
  </section>` : ''}

  <section class="card">
    <h3>🔗 연결 앱</h3>
    <div class="row"><span class="w8">런닝 캘린더</span><input data-bind="profile.links.runningApp" value="${esc(p.links.runningApp)}" class="grow" /></div>
    <div class="row"><span class="w8">독서앱</span><input data-bind="profile.links.readingApp" value="${esc(p.links.readingApp)}" class="grow" /></div>
  </section>

  <section class="card help">
    <h3>💡 PDS 사용법</h3>
    <ol>
      <li><b>Plan</b> (아침 또는 전날 밤): 어제의 '내일 바꿀 1가지' 확인 → 핵심 3 → 블록 조정.</li>
      <li><b>Do</b> (하루 종일): '지금' 카드로 현재 블록 확인, 끝나면 ✓/△/✕. 골든타임은 집중 타이머.</li>
      <li><b>Do</b> 체크: 원시인 버튼(Y만 누르기), SNS 카운터, 독서 쪽수.</li>
      <li><b>See</b> (21:30, 10분): 자동 점수 보고 Keep/Problem/Try 작성 → 내일 계획으로 연결.</li>
      <li>일요일: 주간 See에서 7일 데이터 보고 다음 주 3대 영역 목표 정하기.</li>
    </ol>
  </section>`;
}

/* ================= 일정 (이벤트) ================= */
const REMINDS = [['none', '알림 없음'], ['0', '정각'], ['10', '10분 전'], ['30', '30분 전'], ['60', '1시간 전'], ['1440', '하루 전'], ['eve', '전날 21시']];
const remindLabel = r => (REMINDS.find(x => x[0] === String(r)) || [, ''])[1];
const remOpts = sel => REMINDS.map(([k, l]) => `<option value="${k}" ${k === String(sel) ? 'selected' : ''}>${l}</option>`).join('');
/** 알림 시각(ISO). 종일 일정은 '종일 기준 시각'(기본 09:00)에서 계산 */
function remindAt(ev) {
  if (!ev.date || !ev.remind || ev.remind === 'none') return null;
  const [y, m, d] = ev.date.split('-').map(Number);
  if (ev.remind === 'eve') return new Date(y, m - 1, d - 1, 21, 0).toISOString();
  const [h, mi] = (ev.start_time || S.profile.notify.allDayTime || '09:00').split(':').map(Number);
  return new Date(y, m - 1, d, h, mi - Number(ev.remind)).toISOString();
}
const evTime = e => e.start_time ? e.start_time + (e.end_time ? '–' + e.end_time : '') : '종일';
const evSort = (a, b) => a.date.localeCompare(b.date) || (a.start_time || '').localeCompare(b.start_time || '') || a.title.localeCompare(b.title);
function eventsOn(date) { return S.events.filter(e => e.date === date).sort(evSort); }
function relDay(date) {
  const n = Math.round((parse(date) - parse(today())) / 864e5);
  if (n === 0) return '오늘'; if (n === 1) return '내일'; if (n === 2) return '모레'; if (n === -1) return '어제';
  const d = parse(date); return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
}
/** 불러올 범위: 보고 있는 달 + 그 주 + 오늘~7일 */
function evRange() {
  const { first, last } = monthBounds(S.date); const ws = weekStart(S.date); const t = today();
  return { from: [first, ws, t].sort()[0], to: [last, addDays(ws, 6), addDays(t, 7)].sort()[2] };
}
async function loadEvents(force) {
  const { from, to } = evRange(); const key = from + '|' + to;
  if (!force && S.evKey === key) return;
  try { S.events = await db.listEvents(from, to); S.evKey = key; } catch (e) { S.evErr = e.message || String(e); }
}
function evItem(e, withDate) {
  return `<li class="evi ${e.done ? 'done' : ''}" style="--c:${AREAS[e.area]?.color || '#999'}">
    <input type="checkbox" data-act="evdone" data-id="${e.id}" ${e.done ? 'checked' : ''} title="완료" aria-label="${esc(e.title)} 완료" />
    <button class="evbody" data-act="evedit" data-id="${e.id}" title="눌러서 수정·삭제">
      <span class="evt">${withDate ? `<b>${relDay(e.date)}</b> ` : ''}${evTime(e)}</span>
      <span class="evn">${esc(e.title)}</span>
      ${e.remind && e.remind !== 'none' ? `<span class="evr">🔔${remindLabel(e.remind)}</span>` : ''}
      ${e.memo ? `<small class="evm">${esc(e.memo)}</small>` : ''}
    </button></li>`;
}
function evList(list, { empty = '', withDate = false } = {}) {
  return list.length ? `<ul class="evlist">${list.map(e => evItem(e, withDate)).join('')}</ul>` : `<p class="muted small">${empty}</p>`;
}
function upcomingCard() {
  const t = today(); const end = addDays(t, 7);
  const list = S.events.filter(e => e.date >= t && e.date <= end && !e.done).sort(evSort);
  return `<section class="card upcoming"><div class="ahead"><h3>📌 다가오는 일정 <small>오늘~7일</small></h3>
      <button class="sm primary" data-act="evnew" data-d="${S.date}">+ 일정 추가</button></div>
    ${evList(list.slice(0, 6), { withDate: true, empty: '7일 안에 잡힌 일정이 없어요. 병원·모임·마감 같은 일정을 넣어 두면 알림으로 알려드려요.' })}
    ${list.length > 6 ? `<p class="muted small">외 ${list.length - 6}개 · 달력에서 날짜를 누르면 그날 일정이 보여요</p>` : ''}
  </section>`;
}
function dayEventsBlock(date) {
  const list = eventsOn(date);
  return `<div class="dayev"><div class="ahead"><b>📌 ${date === today() ? '오늘' : fmtDate(date)} 일정${list.length ? ` ${list.length}개` : ''}</b>
      <button class="sm" data-act="evnew" data-d="${date}">+ 일정</button></div>
    ${evList(list, { empty: '일정 없음 · 달력에서 날짜를 누르면 그날 일정이 여기 보여요' })}</div>`;
}
/** Do 타임라인: 블록 + 일정을 시간순으로 (종일 일정은 맨 위) */
function timelineItems() {
  const items = S.day.blocks.map((b, i) => ({ b, i, t: toMin(b.start) }));
  for (const e of eventsOn(S.date)) items.push({ e, t: e.start_time ? toMin(e.start_time) - 0.5 : -1 });
  return items.sort((x, y) => x.t - y.t);
}

/* ---------- 일정 모달 (prompt/confirm 대신 폼) ---------- */
function openEvent(ev, date) {
  if (!ev && ev !== null) return;
  const n = S.profile.notify;
  S.modal = { type: 'event', ev: ev ? { ...ev } : { id: null, date: date || S.date, start_time: null, end_time: null, title: '', area: 'life', memo: '', remind: n.eventDefault || 'none', done: false } };
  render(); setTimeout(() => $('#ev-title')?.focus(), 30);
}
function readEvForm() {
  if (S.modal?.type !== 'event' || !$('#ev-title')) return;
  const e = S.modal.ev;
  Object.assign(e, { title: $('#ev-title').value, date: $('#ev-date').value, start_time: $('#ev-start').value || null, end_time: $('#ev-end').value || null,
    area: $('#ev-area').value, remind: $('#ev-remind').value, memo: $('#ev-memo').value });
  if ($('#ev-done')) e.done = $('#ev-done').checked;
}
function remindText(ev) {
  const ra = remindAt(ev); if (!ra) return '알림 없음';
  const d = new Date(ra);
  return `알림: ${relDay(ymd(d))} ${pad(d.getHours())}:${pad(d.getMinutes())}${!ev.start_time && ev.remind !== 'eve' ? ' (종일 일정 기준 ' + (S.profile.notify.allDayTime || '09:00') + ')' : ''}${d < new Date() ? ' · 이미 지난 시각이라 오지 않아요' : ''}`;
}
function updateRemindHint() { if (S.modal?.type !== 'event') return; readEvForm(); const el = $('#ev-hint'); if (el) el.textContent = remindText(S.modal.ev); }
function modalView() {
  const m = S.modal; if (!m || m.type !== 'event') return '';
  const e = m.ev;
  return `<div class="modal" data-act="modalbg"><div class="mbox" role="dialog" aria-modal="true" aria-label="${e.id ? '일정 수정' : '일정 추가'}">
    <div class="ahead"><h3>${e.id ? '✎ 일정 수정' : '📌 일정 추가'}</h3><button class="icon" data-act="modalclose" aria-label="닫기">✕</button></div>
    <label class="lbl" for="ev-title">제목</label>
    <input id="ev-title" value="${esc(e.title)}" placeholder="예: 치과 예약, 북클럽 모임, 전자책 마감" maxlength="120" />
    <div class="g2">
      <div><label class="lbl" for="ev-date">날짜</label><input type="date" id="ev-date" value="${esc(e.date)}" /></div>
      <div><label class="lbl" for="ev-area">영역</label><select id="ev-area">${areaOpts(e.area)}</select></div>
      <div><label class="lbl" for="ev-start">시작 <small>(비우면 종일)</small></label><input type="time" id="ev-start" value="${e.start_time || ''}" /></div>
      <div><label class="lbl" for="ev-end">끝 <small>(선택)</small></label><input type="time" id="ev-end" value="${e.end_time || ''}" /></div>
    </div>
    <label class="lbl" for="ev-remind">알림</label>
    <select id="ev-remind">${remOpts(e.remind)}</select>
    <p class="muted small" id="ev-hint">${remindText(e)}</p>
    <label class="lbl" for="ev-memo">메모</label>
    <textarea id="ev-memo" rows="2" placeholder="장소, 준비물 등">${esc(e.memo)}</textarea>
    ${e.id ? `<label class="goalchk"><input type="checkbox" id="ev-done" ${e.done ? 'checked' : ''} /> 완료한 일정</label>` : ''}
    ${m.msg ? `<p class="warn small">${esc(m.msg)}</p>` : ''}
    <div class="btnrow">
      <button class="primary" data-act="evsave">${e.id ? '저장' : '추가'}</button>
      <button data-act="modalclose">취소</button>
      ${e.id ? (m.confirmDel ? `<button class="danger" data-act="evdelok">정말 삭제</button>` : `<button class="ghost" data-act="evdel">삭제</button>`) : ''}
    </div>
  </div></div>`;
}
async function saveEventForm() {
  readEvForm(); const m = S.modal; if (!m || m.busy) return; const e = m.ev;
  const err = !e.title.trim() ? '제목을 입력하세요' : !e.date ? '날짜를 고르세요'
    : e.end_time && !e.start_time ? '끝 시간만 넣을 수는 없어요 (시작 시간도 입력)'
    : e.start_time && e.end_time && e.end_time < e.start_time ? '끝 시간이 시작보다 빨라요' : '';
  if (err) { m.msg = err; render(); return; }
  m.busy = true;
  const old = S.events.find(x => x.id === e.id);
  const ra = remindAt(e);
  const same = old && (old.remind_at ? Date.parse(old.remind_at) : null) === (ra ? Date.parse(ra) : null);
  const row = { ...e, title: e.title.trim(), remind_at: ra, reminded_at: same ? old.reminded_at : null };
  try {
    const saved = await db.saveEvent(row);
    S.events = S.events.filter(x => x.id !== saved.id).concat(saved);
    S.modal = null;
    toast(old ? '일정을 고쳤어요' : `일정 추가: ${relDay(saved.date)} ${saved.title}`);
  } catch (er) { m.busy = false; m.msg = '저장 실패: ' + (er.message || er); }
  render();
}
async function deleteEventNow() {
  const e = S.modal?.ev; if (!e?.id) return;
  try { await db.deleteEvent(e.id); S.events = S.events.filter(x => x.id !== e.id); S.modal = null; toast('일정을 삭제했어요'); }
  catch (er) { S.modal.msg = '삭제 실패: ' + (er.message || er); }
  render();
}
async function setEventDone(id, done) {
  const e = S.events.find(x => x.id === id); if (!e) return;
  e.done = done; render();
  try { Object.assign(e, await db.saveEvent(e)); } catch (er) { e.done = !done; toast('저장 실패: ' + (er.message || er)); render(); }
}

/* ================= 알림 (웹푸시 + 앱이 열려 있을 때) ================= */
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const urlB64 = s => { const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...b].map(c => c.charCodeAt(0))); };

/** 하루치 루틴 알림(블록 시작 · 아침 Plan · 하루 리뷰). key 는 서버 큐와 앱 내 알림이 같이 써서 중복을 막는다 */
function routineItemsFor(dt, doc) {
  const n = S.profile.notify; const out = [];
  const at = (hm, minus = 0) => { const [y, m, d] = dt.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return new Date(y, m - 1, d, h, mi - minus).toISOString(); };
  if (n.blockOn && n.blockAreas?.length) {
    let blocks;
    if (doc) { const dd = normDay(doc, dt); syncWork(dd, dt); blocks = dd.blocks; } else blocks = blocksFor(dt, S.profile.template);
    const lead = Number(n.blockLead) || 0;
    for (const b of blocks) {
      if (!n.blockAreas.includes(b.area) || b.status || !b.start) continue;
      out.push({ key: `b:${dt}:${b.tid || b.id}:${b.start}:${lead}`, kind: 'block', date: dt, fire_at: at(b.start, lead),
        title: `⏰ ${b.title}`, body: `${b.start}–${b.end}${lead ? ` · ${lead}분 뒤 시작` : ' 시작'}${b.note ? ' · ' + b.note : ''}`, url: `./?tab=do&date=${dt}` });
    }
  }
  if (n.planOn && n.planTime) out.push({ key: `p:${dt}:${n.planTime}`, kind: 'plan', date: dt, fire_at: at(n.planTime),
    title: '☀️ 오늘의 Plan', body: '핵심 3 정하고 오늘 블록·일정 확인하기', url: `./?tab=plan&date=${dt}` });
  if (n.reviewOn && S.profile.reviewTime) out.push({ key: `r:${dt}:${S.profile.reviewTime}`, kind: 'review', date: dt, fire_at: at(S.profile.reviewTime),
    title: '🌙 하루 리뷰 시간', body: '10분 See: 점수 보고 Keep/Problem/Try', url: `./?tab=see&date=${dt}` });
  return out;
}
let pushTimer = null;
function schedulePushSync() { clearTimeout(pushTimer); pushTimer = setTimeout(() => syncPushQueue(), 2000); }
/** 앞으로 14일 루틴 알림을 서버 큐(pds_push_queue)에 다시 만든다. 서버가 1분마다 시각 된 것을 푸시 */
async function syncPushQueue() {
  if (!db.isCloud || !S.user || !S.profile?.notify?.push) return;
  try {
    const t = today(); const end = addDays(t, 13);
    const rows = await db.listDays(t, end); const map = Object.fromEntries(rows.map(r => [r.date, r.data]));
    if (S.day && S.date >= t && S.date <= end) map[S.date] = S.day;
    const soon = Date.now() + 30000; const items = [];
    for (let dt = t; dt <= end; dt = addDays(dt, 1)) for (const it of routineItemsFor(dt, map[dt] || null)) if (Date.parse(it.fire_at) > soon) items.push(it);
    await db.replacePushQueue(items);
    S.push.pending = items.length; S.push.syncedAt = Date.now();
  } catch (e) { S.push.msg = '알림 예약 실패: ' + (e.message || e); }
  updatePushStateDom();
}
/** 앱이 열려 있을 때(15초마다): 시각 된 일정·오늘 루틴 알림. 웹푸시가 안 되는 기기의 대체 경로 */
const NKEY = 'pds-notified';
function localNotifyTick() {
  const nowMs = Date.now(); const WIN = 120000;
  let seen; try { seen = JSON.parse(localStorage.getItem(NKEY)) || {}; } catch { seen = {}; }
  const due = [];
  for (const e of S.events) {
    if (e.done || !e.remind_at) continue;
    const t = Date.parse(e.remind_at);
    if (t <= nowMs && nowMs - t < WIN) due.push({ key: 'ev:' + e.id, title: '📌 ' + e.title, body: `${relDay(e.date)} ${evTime(e)}${e.memo ? ' · ' + e.memo : ''}` });
  }
  if (S.date === today() && S.day) for (const it of routineItemsFor(S.date, S.day)) {
    const t = Date.parse(it.fire_at);
    if (t > nowMs || nowMs - t >= WIN) continue;
    if (it.kind === 'review' && S.day.review?.at) continue;
    if (it.kind === 'plan' && S.day.top3.every(x => x.text.trim())) continue;
    due.push(it);
  }
  let changed = false;
  for (const d of due) if (!seen[d.key]) { seen[d.key] = nowMs; changed = true; notify(d.title, d.body, d.key); }
  if (changed) {
    for (const k of Object.keys(seen)) if (nowMs - seen[k] > 2 * 864e5) delete seen[k];
    localStorage.setItem(NKEY, JSON.stringify(seen));
  }
}
function pushStateHtml() {
  const P = S.push;
  const sup = typeof Notification !== 'undefined' && 'serviceWorker' in navigator;
  const pushSup = sup && 'PushManager' in window;
  const perm = sup ? Notification.permission : 'unsupported';
  const st = !sup ? `❌ 이 브라우저는 알림을 지원하지 않아요${isIOS() && !isStandalone() ? ' — 아이폰은 홈 화면에 추가한 앱에서 켜주세요' : ''}`
    : perm === 'denied' ? '🚫 알림이 차단돼 있어요. 브라우저(또는 폰) 설정에서 이 사이트 알림을 허용해 주세요.'
    : P.sub ? '✅ 이 기기: 푸시 알림 켜짐 (앱을 닫아도 와요)'
    : perm === 'granted' ? (pushSup && db.isCloud ? '🟡 알림 권한은 있지만 푸시 등록 전이에요 — 아래 버튼을 눌러 주세요' : '🟡 앱이 열려 있을 때만 알림이 와요')
    : '⚪ 이 기기: 알림 꺼짐';
  const evN = S.events.filter(e => e.remind_at && !e.reminded_at && !e.done && Date.parse(e.remind_at) > Date.now()).length;
  const meta = [P.devices != null ? `알림 받는 기기 ${P.devices}대` : '', P.pending != null && S.profile.notify.push ? `예약된 루틴 알림 ${P.pending}개(14일)` : '', evN ? `일정 알림 ${evN}개 대기` : ''].filter(Boolean).join(' · ');
  return `<p class="pushst"><b>${st}</b></p>${meta ? `<p class="muted small">${meta}</p>` : ''}${P.msg ? `<p class="small warn">${esc(P.msg)}</p>` : ''}
    <div class="btnrow">${P.sub ? `<button data-act="pushtest">테스트 알림 보내기</button><button class="ghost" data-act="pushoff">이 기기 알림 끄기</button>`
      : `<button class="primary" data-act="pushon" ${!sup || perm === 'denied' ? 'disabled' : ''}>🔔 이 기기에서 알림 켜기</button>`}</div>`;
}
function updatePushStateDom() { const el = $('#pushstate'); if (el) el.innerHTML = pushStateHtml(); }
async function refreshPushState() {
  if (S.push.busy || Date.now() - (S.push.checkedAt || 0) < 5000) { updatePushStateDom(); return; }
  S.push.busy = true;
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg?.pushManager ? await reg.pushManager.getSubscription().catch(() => null) : null;
    S.push.sub = !!sub;
    if (db.isCloud) {
      if (sub) await db.savePushSub(sub.toJSON(), navigator.userAgent).catch(() => { }); // 다른 계정으로 로그인한 경우 등 재등록
      S.push.devices = await db.countPushSubs().catch(() => null);
      if (S.profile.notify.push) S.push.pending = await db.pendingPushCount().catch(() => S.push.pending);
    }
    S.push.checkedAt = Date.now();
  } finally { S.push.busy = false; }
  updatePushStateDom();
}
async function enablePush() {
  S.push.msg = '';
  try {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator))
      throw new Error(isIOS() ? '아이폰은 Safari 공유 → 홈 화면에 추가한 앱으로 열어야 알림을 켜 수 있어요.' : '이 브라우저는 알림을 지원하지 않아요.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error(perm === 'denied' ? '알림이 차단됐어요. 브라우저(또는 폰) 설정에서 이 사이트 알림을 허용해 주세요.' : '알림 권한을 허용하지 않았어요.');
    const reg = await navigator.serviceWorker.ready;
    if (!reg.pushManager || !db.isCloud) { S.push.msg = '이 기기는 백그라운드 푸시를 지원하지 않아 앱이 열려 있을 때만 알림이 와요.'; toast('알림 허용됨 (앱이 열려 있을 때)'); render(); return; }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(VAPID_PUBLIC_KEY) });
    await db.savePushSub(sub.toJSON(), navigator.userAgent);
    S.profile.notify.push = true; markDirty('profile'); await flush();
    S.push.sub = true; S.push.checkedAt = 0;
    await syncPushQueue();
    toast('이 기기에서 알림을 켰어요 🔔 — 테스트 알림으로 확인해 보세요');
  } catch (e) { S.push.msg = e.message || String(e); }
  render();
}
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration(); const sub = await reg?.pushManager?.getSubscription();
    if (sub) { await db.deletePushSub(sub.endpoint).catch(() => { }); await sub.unsubscribe().catch(() => { }); }
    const left = await db.countPushSubs().catch(() => 0);
    if (!left) { S.profile.notify.push = false; markDirty('profile'); await db.replacePushQueue([]).catch(() => { }); S.push.pending = 0; }
    S.push.sub = false; S.push.checkedAt = 0; S.push.msg = ''; toast('이 기기 알림을 껏어요');
  } catch (e) { S.push.msg = e.message || String(e); }
  render();
}
async function testPush() {
  try {
    const r = await db.sendTestPush();
    S.push.msg = r.ok ? '' : '테스트 알림을 보내지 못했어요: ' + ((r.errors || []).join(', ') || '등록된 기기 없음');
    if (r.ok) toast(`테스트 알림을 보냈어요 (${r.ok}/${r.devices}대) — 몇 초 안에 와요`);
  } catch (e) { S.push.msg = '테스트 실패: ' + (e.message || e); }
  updatePushStateDom();
}
function blockPreview() {
  const n = S.profile.notify;
  const bl = S.day.blocks.filter(b => n.blockAreas.includes(b.area));
  return bl.length ? `${S.date === today() ? '오늘' : fmtDate(S.date)}: ${bl.map(b => `${b.start} ${esc(b.title)}`).join(', ')}` : '이 날은 해당 블록이 없어요.';
}
function notifySettings() {
  const p = S.profile; const n = p.notify;
  return `<section class="card" id="notifycard">
    <h3>🔔 알림</h3>
    <div id="pushstate">${pushStateHtml()}</div>
    <p class="muted small iosnote">📱 <b>아이폰·아이패드</b>는 Safari에서 <b>공유 → 홈 화면에 추가</b>로 설치한 앱에서만 푸시 알림이 와요(iOS 16.4 이상). 설치한 앱을 열고 여기서 '이 기기에서 알림 켜기'를 누르세요. 안드로이드·PC 크롬은 브라우저에서 바로 켤 수 있고, 기기마다 한 번씩 켜야 해요.</p>
    <div class="nrow"><span class="grow">새 일정 기본 알림</span><select data-bind="profile.notify.eventDefault" class="w10">${remOpts(n.eventDefault)}</select></div>
    <div class="nrow"><span class="grow">종일 일정 기준 시각 <small class="muted">(정각·N분 전 계산)</small></span><input type="time" data-bind="profile.notify.allDayTime" value="${esc(n.allDayTime)}" /></div>
    <div class="nrow"><label class="grow"><input type="checkbox" data-bind="profile.notify.blockOn" ${n.blockOn ? 'checked' : ''} /> 블록 시작 알림</label>
      <select data-bind="profile.notify.blockLead" class="w10" ${n.blockOn ? '' : 'disabled'}>${[['0', '정각'], ['5', '5분 전'], ['10', '10분 전'], ['15', '15분 전']].map(([k, l]) => `<option value="${k}" ${k === String(n.blockLead) ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    ${n.blockOn ? `<div class="row chips">${Object.entries(AREAS).map(([k, v]) => `<button class="chip ${n.blockAreas.includes(k) ? 'on' : ''}" data-act="nfarea" data-a="${k}">${v.label}</button>`).join('')}</div>
      <p class="muted small">켜 둔 영역의 블록만 알려요 (런닝·사업=글쓰기 골든타임·독서가 기본). ${blockPreview()}</p>` : ''}
    <div class="nrow"><label class="grow"><input type="checkbox" data-bind="profile.notify.planOn" ${n.planOn ? 'checked' : ''} /> 아침 Plan 알림</label><input type="time" data-bind="profile.notify.planTime" value="${esc(n.planTime)}" ${n.planOn ? '' : 'disabled'} /></div>
    <div class="nrow"><label class="grow"><input type="checkbox" data-bind="profile.notify.reviewOn" ${n.reviewOn ? 'checked' : ''} /> 하루 리뷰 알림</label><input type="time" data-bind="profile.reviewTime" value="${esc(p.reviewTime)}" ${n.reviewOn ? '' : 'disabled'} /></div>
    <div class="nrow"><label class="grow"><input type="checkbox" data-bind="profile.notify.focusOn" ${n.focusOn ? 'checked' : ''} /> 집중 타이머 종료 알림</label></div>
    <p class="muted small">리뷰를 이미 쓴 날은 리뷰 알림을 보내지 않아요. 설정·블록을 바꾸면 앞으로 14일 알림 예약이 자동으로 다시 만들어져요(앱을 열 때마다 갱신). 일정 알림은 일정마다 따로 고를 수 있어요.</p>
  </section>`;
}

/* ================= focus timer ================= */
const FKEY = 'pds-focus';
const getFocus = () => { try { return JSON.parse(localStorage.getItem(FKEY)); } catch { return null; } };
function focusOverlay() {
  const f = getFocus(); if (!f) return '';
  const left = Math.max(0, Math.round((f.end - Date.now()) / 1000));
  return `<div class="focus" id="focus">
    <div class="fbox">
      <small>집중 중 · ${esc(f.date)}</small>
      <h2>${esc(f.title)}</h2>
      ${/글쓰기|골든/.test(f.title) ? '<p class="warn">📵 휴대폰 알림 차단 했나요?</p>' : ''}
      <div class="ftime" id="ftime">${pad(Math.floor(left / 60))}:${pad(left % 60)}</div>
      <div class="btnrow center">${[25, 50].map(m => `<button class="sm" data-act="focusset" data-m="${m}">${m}분</button>`).join('')}
        ${f.blockEnd ? `<button class="sm" data-act="focusset" data-m="end">블록 끝(${f.blockEnd})까지</button>` : ''}</div>
      <div class="btnrow center"><button class="primary" data-act="focusdone">완료로 기록</button><button data-act="focusstop">중단</button></div>
    </div></div>`;
}
function startFocus(i) {
  const b = S.day.blocks[i];
  const left = toMin(b.end) - nowMin();
  const def = S.date === today() && left > 0 ? left : toMin(b.end) - toMin(b.start);
  const min = Math.max(1, Math.min(def, 50));
  const f = { date: S.date, i, blockId: b.id, title: b.title, blockEnd: b.end, end: Date.now() + min * 60000, min, start: Date.now() };
  localStorage.setItem(FKEY, JSON.stringify(f));
  queueFocusPush(f);
  render();
}
/** 집중 타이머 종료를 서버에도 예약 → 화면이 꺼져 있어도 웹푸시로 알림 */
function queueFocusPush(f) {
  if (!db.isCloud || !S.profile.notify.push || !S.profile.notify.focusOn) return;
  db.queuePush({ key: 'f:' + f.start, kind: 'focus', date: f.date, fire_at: new Date(f.end).toISOString(), title: '⏳ 집중 시간 끝', body: f.title + ' — 완료로 기록할까요?', url: './?tab=do' }).catch(() => { });
}
function setFocusLen(m) {
  const f = getFocus(); if (!f) return;
  let min;
  if (m === 'end') { const e = new Date(); e.setHours(...f.blockEnd.split(':').map(Number), 0, 0); min = Math.max(1, Math.round((e - f.start) / 60000)); }
  else min = Number(m);
  Object.assign(f, { min, end: f.start + min * 60000, notified: false });
  localStorage.setItem(FKEY, JSON.stringify(f)); queueFocusPush(f); render();
}
async function endFocus(done) {
  const f = getFocus(); localStorage.removeItem(FKEY);
  if (f && db.isCloud && f.end > Date.now()) db.unqueuePush('f:' + f.start).catch(() => { });
  if (done && f) {
    if (f.date !== S.date) await loadDate(f.date);
    const b = S.day.blocks.find(x => x.id === f.blockId);
    if (b) b.status = 'done';
    S.day.focus = [...(S.day.focus || []), { title: f.title, area: b?.area, min: f.start ? Math.max(1, Math.round((Math.min(Date.now(), f.end) - f.start) / 60000)) : f.min, at: new Date().toISOString() }];
    markDirty('day');
  }
  render();
}
setInterval(() => {
  const f = getFocus(); const el = $('#ftime');
  if (f && el) {
    const left = Math.max(0, Math.round((f.end - Date.now()) / 1000));
    el.textContent = `${pad(Math.floor(left / 60))}:${pad(left % 60)}`;
    if (left === 0 && !f.notified) {
      f.notified = true; localStorage.setItem(FKEY, JSON.stringify(f));
      if (S.profile?.notify?.focusOn !== false) notify('⏳ 집중 시간 끝', f.title + ' — 완료로 기록할까요?', 'f:' + f.start);
      navigator.vibrate?.([200, 100, 200]);
    }
  }
}, 1000);
/** 앱이 열려 있을 때 알림: 토스트 + 시스템 알림(서비스워커 showNotification 우선, 안드로이드는 이것만 됨).
 *  웹푸시와 같은 tag 를 써서 둘 다 와도 알림은 하나만 남는다. */
async function notify(title, body, tag) {
  toast(`${title}: ${body}`, 6000);
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const opt = { body, tag: tag || undefined, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './' } };
  try { const reg = await navigator.serviceWorker?.getRegistration(); if (reg) { await reg.showNotification(title, opt); return; } } catch { }
  try { new Notification(title, opt); } catch { }
}
// 매 분: '지금' 카드 갱신 + 리뷰 시각 알림
let lastMinute = -1;
setInterval(() => {
  if (!S.user || !S.profile) return;
  const m = nowMin(); if (m === lastMinute) return; lastMinute = m;
  const a = document.activeElement;
  const typing = a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName);
  if (S.date === today() && (S.tab === 'do' || S.tab === 'home') && !typing && !getFocus() && !S.modal) render();
}, 15000);
setInterval(() => { if (S.user && S.profile) localNotifyTick(); }, 15000);

/* ================= events ================= */
function setPath(path, value) {
  const keys = path.split('.');
  const root = keys.shift();
  let o = S[root];
  while (keys.length > 1) { const k = keys.shift(); o = o[k] ??= {}; }
  o[keys[0]] = value;
  return root;
}
document.addEventListener('input', e => {
  const el = e.target; const path = el.dataset?.bind; if (!path) return;
  let v = el.value;
  if (el.type === 'number') v = v === '' ? 0 : Number(v);
  if (el.type === 'checkbox') v = el.checked;
  const root = setPath(path, v);
  if (el.dataset.track) { S.day.reading[el.dataset.track] = true; markDirty('day'); }
  markDirty(root);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'datepick' && el.value) { loadDate(el.value); return; }
  if (el.id === 'importfile' && el.files[0]) { importFile(el.files[0]); return; }
  // 영역/요일처럼 색이 바뀌는 항목은 다시 그리기
  if (el.dataset?.bind && (el.tagName === 'SELECT' || el.dataset.track || el.type === 'checkbox')) render();
  if (el.id?.startsWith('ev-')) updateRemindHint();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'newtask') { e.preventDefault(); act('addtask'); }
  if (e.key === 'Enter' && e.target.id === 'rpw') { e.preventDefault(); act('readconnect'); }
  if (e.key === 'Enter' && e.target.dataset?.ph) { e.preventDefault(); act('addtaskph', { ph: e.target.dataset.ph }); }
  if (e.key === 'Enter' && e.target.id === 'bookadd') { e.preventDefault(); act('addbook'); }
  if (e.key === 'Enter' && e.target.closest?.('#loginform')) { e.preventDefault(); act('login'); }
  if (e.key === 'Enter' && e.target.closest?.('.mbox') && e.target.tagName === 'INPUT') { e.preventDefault(); act('evsave'); }
  if (e.key === 'Escape' && S.modal) { S.modal = null; render(); }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.dataset.act === 'modalbg' && e.target !== el) return; // 모달 안쪽 클릭은 닫지 않음
  if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.classList.contains('banner')) e.preventDefault?.();
  if (el.type === 'checkbox') { /* 체크박스는 기본 동작 유지 */ }
  act(el.dataset.act, el.dataset, el);
});

async function act(a, ds = {}, el) {
  const d = S.day; const p = S.profile;
  switch (a) {
    case 'tab': S.tab = ds.tab; render(); scrollTo(0, 0); break;
    case 'date': await loadDate(addDays(S.date, Number(ds.d))); break;
    case 'pickdate':
      if (S.date !== today()) { await loadDate(today()); break; }
      try { $('#datepick').showPicker(); } catch { $('#datepick').hidden = false; }
      break;
    case 'goto': S.seeView = 'day'; await loadDate(ds.d); break;
    case 'pick': await loadDate(ds.d); break;
    case 'monthnav': { const x = parse(S.date.slice(0, 8) + '01'); x.setMonth(x.getMonth() + Number(ds.n)); const t = today(); await loadDate(ymd(x).slice(0, 7) === t.slice(0, 7) ? t : ymd(x)); break; }
    case 'gotab': S.tab = ds.tab; if (ds.see) S.seeView = ds.see; render(); scrollTo(0, 0); break;
    case 'addtaskph': {
      const inp = document.querySelector(`.addph[data-ph="${ds.ph}"]`); const t = inp?.value.trim(); if (!t) break;
      d.tasks.push({ id: uid(), text: t, area: ds.ph === 'do' ? 'biz' : ds.ph === 'see' ? 'review' : 'life', phase: ds.ph, done: false });
      markDirty('day'); render(); document.querySelector(`.addph[data-ph="${ds.ph}"]`)?.focus(); break;
    }
    case 'seeview': S.seeView = ds.v; render(); break;
    // plan
    case 'lesson2task': d.tasks.push({ id: uid(), text: S.prev.review.change, area: 'life', done: false }); markDirty('day'); toast('할 일에 추가했어요'); render(); break;
    case 'addblock': d.blocks.push({ id: uid(), start: '12:00', end: '13:00', title: '새 블록', area: 'life', note: '', status: '' }); markDirty('day'); render(); break;
    case 'delblock': d.blocks.splice(Number(ds.i), 1); markDirty('day'); render(); break;
    case 'sortblocks': d.blocks.sort((x, y) => toMin(x.start) - toMin(y.start)); markDirty('day'); render(); break;
    case 'resetblocks':
      if (!confirm('오늘 블록을 루틴 템플릿으로 다시 만들까요? (체크 상태가 초기화됩니다)')) break;
      d.blocks = blocksFor(S.date, p.template); markDirty('day'); render(); break;
    case 'addtask': {
      const inp = $('#newtask'); const t = inp?.value.trim(); if (!t) break;
      d.tasks.push({ id: uid(), text: t, area: $('#newtaskarea')?.value || 'biz', phase: $('#newtaskphase')?.value || 'do', done: false });
      markDirty('day'); render(); $('#newtask')?.focus(); break;
    }
    case 'deltask': d.tasks.splice(Number(ds.i), 1); markDirty('day'); render(); break;
    case 'toggletask': d.tasks[ds.i].done = el.checked; markDirty('day'); render(); break;
    case 'movetask': {
      const t = d.tasks.splice(Number(ds.i), 1)[0]; markDirty('day'); await flush();
      const nd = addDays(S.date, 1);
      const next = normDay(await db.getDay(nd), nd);
      next.tasks.push({ ...t, done: false }); await db.saveDay(nd, next); S.home = null;
      toast('내일로 옮겼어요'); render(); break;
    }
    case 'action2task': { const t = p.tracks[ds.i]; d.tasks.push({ id: uid(), text: `[${t.name}] ${t.action}`, area: 'read', done: false }); markDirty('day'); toast('오늘 할 일에 추가'); render(); break; }
    // do
    case 'bstatus': { const b = d.blocks[ds.i]; b.status = b.status === ds.s ? '' : ds.s; markDirty('day'); render(); break; }
    case 'toggletop': d.top3[ds.i].done = el.checked; markDirty('day'); render(); break;
    case 'cave': d.caveman[ds.no] = d.caveman[ds.no] === true ? false : true; markDirty('day'); render(); break;
    case 'sns': d.sns[ds.k] = Math.max(0, (Number(d.sns[ds.k]) || 0) + Number(ds.n)); markDirty('day'); render(); break;
    case 'snsset': d.sns[ds.k] = Number(ds.v); markDirty('day'); render(); break;
    case 'readtoggle': d.reading[ds.id] = !d.reading[ds.id]; markDirty('day'); render(); break;
    case 'finish': {
      const t = p.tracks[ds.i];
      if (!confirm(`『${t.book}』 완독으로 기록할까요?`)) break;
      p.books.push({ id: uid(), title: t.book, track: t.name, date: S.date });
      d.reading[t.id] = true;
      const nb = prompt('다음에 읽을 책 제목 (비워두면 나중에)', '') || '';
      Object.assign(t, { book: nb, page: 0, total: 0, action: '' });
      markDirty('profile'); markDirty('day'); toast('완독 기록 완료 📚'); render(); break;
    }
    case 'focus': startFocus(Number(ds.i)); break;
    case 'focusset': setFocusLen(ds.m); break;
    case 'focusdone': await endFocus(true); toast('완료로 기록했어요'); break;
    case 'focusstop': await endFocus(false); break;
    // see
    case 'energy': d.review.energy = Number(ds.n); markDirty('day'); render(); break;
    case 'reviewdone':
      d.review.at = new Date().toISOString(); markDirty('day'); await flush();
      toast('리뷰 저장! 내일 계획으로 이동합니다');
      S.tab = 'plan'; await loadDate(addDays(S.date, 1)); scrollTo(0, 0); break;
    case 'goaldone': S.week.goalsDone = { ...S.week.goalsDone, [ds.a]: el.checked }; markDirty('week'); break;
    // settings
    case 'workcycle': {
      const dt = ds.d; p.work ||= {};
      p.work[dt] = workMode(dt) === 'work' ? 'off' : 'work';
      markDirty('profile');
      if (dt === S.date && syncWork(d, dt)) markDirty('day');
      S.home = null; render(); break;
    }
    case 'workfill': {
      p.work ||= {}; const { first, last } = monthBounds(ds.m + '-01');
      for (let dt = first; dt <= last; dt = addDays(dt, 1)) if (!p.work[dt]) p.work[dt] = defaultWork(dt);
      markDirty('profile'); toast('이 달 근무표를 확정했어요'); render(); break;
    }
    case 'workclear': {
      if (!confirm('이 달 근무표 지정을 모두 지울까요? (평일 근무·주말 휴무 기본값으로)')) break;
      const { first, last } = monthBounds(ds.m + '-01');
      for (const k of Object.keys(p.work || {})) if (k >= first && k <= last) delete p.work[k];
      markDirty('profile'); if (syncWork(d, S.date)) markDirty('day'); S.home = null; render(); break;
    }
    case 'workmonth': { const x = parse((S.workMonth || S.date.slice(0, 7)) + '-01'); x.setMonth(x.getMonth() + Number(ds.n)); S.workMonth = ymd(x).slice(0, 7); render(); break; }
    case 'tplday': { const t = p.template[ds.i]; const w = Number(ds.w); t.days = t.days.includes(w) ? t.days.filter(x => x !== w) : [...t.days, w]; markDirty('profile'); render(); break; }
    case 'addtpl': p.template.push({ id: 't' + uid(), start: '12:00', end: '13:00', title: '새 블록', area: 'life', days: [1, 2, 3, 4, 5], note: '' }); markDirty('profile'); render(); break;
    case 'deltpl': p.template.splice(Number(ds.i), 1); markDirty('profile'); render(); break;
    case 'sorttpl': p.template.sort((x, y) => toMin(x.start) - toMin(y.start)); markDirty('profile'); render(); break;
    case 'resettpl': if (confirm('루틴 템플릿을 문서 기본값으로 되돌릴까요?')) { p.template = structuredClone(DEFAULT_TEMPLATE); markDirty('profile'); render(); } break;
    case 'applytpl': if (confirm(`${fmtDate(S.date)} 블록을 현재 템플릿으로 다시 만들까요?`)) { d.blocks = blocksFor(S.date, p.template); markDirty('day'); toast('적용했어요'); } break;
    case 'addbook': { const v = $('#bookadd')?.value.trim(); if (!v) break; p.books.push({ id: uid(), title: v, track: '직접 추가', date: S.date }); markDirty('profile'); render(); break; }
    case 'delbook': p.books = p.books.filter(b => b.id !== ds.id); markDirty('profile'); render(); break;
    // 일정
    case 'evnew': openEvent(null, ds.d || S.date); break;
    case 'evedit': openEvent(S.events.find(x => x.id === ds.id)); break;
    case 'evsave': await saveEventForm(); break;
    case 'evdel': readEvForm(); S.modal.confirmDel = true; render(); break;
    case 'evdelok': await deleteEventNow(); break;
    case 'evdone': await setEventDone(ds.id, el.checked); break;
    case 'evtoggle': { const e = S.events.find(x => x.id === ds.id); if (e) await setEventDone(e.id, !e.done); break; }
    case 'modalclose': case 'modalbg': S.modal = null; render(); break;
    // 알림
    case 'pushon': await enablePush(); break;
    case 'pushoff': await disablePush(); break;
    case 'pushtest': await testPush(); break;
    case 'nfarea': { const n = p.notify; n.blockAreas = n.blockAreas.includes(ds.a) ? n.blockAreas.filter(x => x !== ds.a) : [...n.blockAreas, ds.a]; markDirty('profile'); render(); break; }
    case 'export': {
      await flush();
      const j = await db.exportAll();
      const url = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' }));
      const aEl = document.createElement('a'); aEl.href = url; aEl.download = `pds-backup-${today()}.json`; aEl.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000); break;
    }
    case 'logout': await flush(); await db.signOut(); S.user = null; render(); break;
    case 'openurl': window.open(ds.url, '_blank', 'noopener'); break;
    case 'readconnect': {
      const em = $('#remail')?.value.trim(); const pw = $('#rpw')?.value;
      if (!em || !pw) { toast('이메일과 비밀번호를 입력하세요'); break; }
      try { await db.readingConnect(em, pw); await loadReading(S.date); S.home = null; toast('독서앱 연결 완료 📖'); render(); }
      catch (e) { toast('연결 실패: ' + (e.message || e).replace('Invalid login credentials', '이메일 또는 비밀번호가 맞지 않아요')); }
      break;
    }
    case 'readdisconnect': if (confirm('독서앱 연결을 해제할까요? (독서앱 데이터는 그대로)')) { await db.readingDisconnect(); S.reading = null; render(); } break;
    case 'readrefresh': await loadReading(S.date); toast('독서앱 데이터를 다시 불러왔어요'); render(); break;
    // auth
    case 'login': case 'signup': case 'reset': await authAction(a); break;
  }
}

async function importFile(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'pds-planner') throw new Error('PDS 플래너 백업 파일이 아니에요');
    if (!confirm('백업을 가져올까요? 같은 날짜 데이터는 덮어씁니다.')) return;
    await db.importAll(j);
    S.profile = mergeProfile(await db.getProfile());
    await loadDate(S.date); toast('가져오기 완료');
  } catch (e) { toast('가져오기 실패: ' + e.message); }
}

/* ================= auth ================= */
function loginView() {
  return `<div class="login">
    <div class="logo">더원 <b>PDS</b></div>
    <p class="muted">Plan · Do · See — 하루를 계획하고, 실행하고, 리뷰합니다.</p>
    <form id="loginform" onsubmit="return false">
      <input id="email" type="email" placeholder="이메일" autocomplete="username" />
      <input id="pw" type="password" placeholder="비밀번호 (6자 이상)" autocomplete="current-password" />
      <button class="primary" data-act="login">로그인</button>
      <div class="btnrow center"><button class="ghost" data-act="signup">처음이에요 (가입)</button><button class="ghost" data-act="reset">비밀번호 재설정</button></div>
    </form>
    <p class="muted small">런닝 캘린더와 같은 계정으로 로그인하면 오늘 훈련과 대회 D-day가 함께 보여요.</p>
    <p id="loginmsg" class="warn"></p>
  </div>`;
}
async function authAction(a) {
  const email = $('#email')?.value.trim(); const pw = $('#pw')?.value;
  const msg = $('#loginmsg');
  try {
    if (a === 'reset') { if (!email) throw new Error('이메일을 입력하세요'); await db.sendPasswordReset(email); msg.textContent = '재설정 메일을 보냈어요.'; return; }
    if (!email || !pw) throw new Error('이메일과 비밀번호를 입력하세요');
    if (a === 'signup') { const r = await db.signUp(email, pw); if (!r.session) { msg.textContent = '가입 완료. 메일 인증 후 로그인하세요.'; return; } }
    else {
      await db.signIn(email, pw);
      // 같은 계정으로 독서앱도 자동 연결 시도 (실패해도 무시)
      if (db.hasReading && !(await db.readingUser())) { try { await db.readingConnect(email, pw); } catch { } }
    }
    await boot();
  } catch (e) { msg.textContent = (e.message || String(e)).replace('Invalid login credentials', '이메일 또는 비밀번호가 맞지 않아요'); }
}

/* ================= boot ================= */
async function boot() {
  S.user = await db.getUser();
  if (!S.user) { render(); return; }
  S.profile = mergeProfile(await db.getProfile());
  const cal = await db.nextRace(today());
  S.raceFromCal = cal;
  S.race = cal ? { name: cal.name, date: cal.date, goal: cal.goal_time || S.profile.race.goal } : (S.profile.race?.date ? S.profile.race : null);
  if (!(await db.getProfile())) await db.saveProfile(S.profile);
  // 알림에서 열면 ?tab=do&date=YYYY-MM-DD
  const q = new URLSearchParams(location.search);
  if (['home', 'plan', 'do', 'see', 'set'].includes(q.get('tab'))) S.tab = q.get('tab');
  const qd = /^\d{4}-\d{2}-\d{2}$/.test(q.get('date') || '') ? q.get('date') : today();
  if (q.has('tab') || q.has('date')) history.replaceState(null, '', location.pathname);
  await loadDate(qd);
  refreshPushState().then(() => syncPushQueue());
}
navigator.serviceWorker?.addEventListener('message', async e => {
  if (e.data?.type !== 'open' || !S.user) return;
  const u = new URL(e.data.url); const tab = u.searchParams.get('tab'); const dt = u.searchParams.get('date');
  if (tab) S.tab = tab;
  if (dt && dt !== S.date) await loadDate(dt); else render();
});
db.init();
db.initReading();
db.onAuth(async (ev) => {
  if (ev === 'PASSWORD_RECOVERY') {
    const pw = prompt('새 비밀번호를 입력하세요 (6자 이상)');
    if (pw) { try { await db.updatePassword(pw); toast('비밀번호를 바꿨어요'); } catch (e) { toast(e.message); } }
  }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
boot().catch(e => { $('#app').innerHTML = `<div class="login"><p class="warn">불러오기 실패: ${esc(e.message)}</p><button onclick="location.reload()">다시 시도</button></div>`; });
