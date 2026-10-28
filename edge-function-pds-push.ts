// Supabase Edge Function: pds-push
// pg_cron이 1분마다 호출(x-cron-secret) → 시각이 된 PDS 알림을 웹 푸시로 보낸다.
//  1) 일정 알림: pds_events.remind_at 이 지났고 reminded_at 이 비어 있는 일정
//  2) 루틴 알림: pds_push_queue (블록 시작 · 아침 Plan · 하루 리뷰 · 집중 타이머 종료)
// 보낼 행은 먼저 reminded_at / sent_at 을 채워 '선점'한 뒤 보내므로 같은 알림이 두 번 가지 않는다.
// 앱에서 '테스트 알림'은 사용자 JWT(Authorization) + {test:true} 로 호출한다.
// VAPID 키·CRON_SECRET 은 런닝 캘린더 daily-reminder 와 같은 프로젝트 시크릿을 같이 쓴다.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
webpush.setVapidDetails("mailto:cjever2h@gmail.com", VAPID_PUBLIC, VAPID_PRIVATE);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function admin() {
  let key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!key) { try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); key = k.default ?? Object.values(k)[0] ?? ""; } catch { /* ignore */ } }
  return createClient(Deno.env.get("SUPABASE_URL")!, key, { auth: { persistSession: false } });
}

type Sub = { endpoint: string; p256dh: string; auth: string };
type Msg = { title: string; body: string; url?: string; tag?: string };

async function sendTo(sb: ReturnType<typeof admin>, userId: string, msg: Msg, cache: Map<string, Sub[]>) {
  let subs = cache.get(userId);
  if (!subs) {
    const { data } = await sb.from("pds_push_subs").select("endpoint,p256dh,auth").eq("user_id", userId);
    subs = data ?? []; cache.set(userId, subs);
  }
  const r = { ok: 0, removed: 0, errors: [] as string[] };
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ ...msg, url: msg.url || "./" }), { TTL: 3600, urgency: "high" });
      r.ok++;
      await sb.from("pds_push_subs").update({ last_ok_at: new Date().toISOString() }).eq("user_id", userId).eq("endpoint", s.endpoint);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) { await sb.from("pds_push_subs").delete().eq("user_id", userId).eq("endpoint", s.endpoint); r.removed++; }
      else r.errors.push(`${code ?? ""} ${String((e as Error).message ?? e)}`.trim());
    }
  }
  return r;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const input = await req.json().catch(() => ({}));
  const sb = admin();
  const cache = new Map<string, Sub[]>();

  // ---- 앱에서 보내는 테스트 알림 (로그인한 본인 기기들로) ----
  if (input.test) {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error } = await sb.auth.getUser(token);
    if (error || !u?.user) return json({ error: "unauthorized" }, 401);
    const r = await sendTo(sb, u.user.id, { title: "🔔 PDS 테스트 알림", body: "이 기기에서 PDS 알림을 받을 수 있어요.", url: "./?tab=set", tag: "pds-test" }, cache);
    return json({ test: true, devices: cache.get(u.user.id)?.length ?? 0, ...r });
  }

  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) return json({ error: "forbidden" }, 403);

  const now = new Date();
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - 15 * 60000).toISOString(); // 15분 넘게 지난 알림은 보내지 않음
  const out = { at: nowIso, events: 0, routines: 0, skipped: 0, ok: 0, removed: 0, errors: [] as string[] };

  // 1) 일정 알림: 선점(update … returning) 후 발송
  const { data: evs, error: e1 } = await sb.from("pds_events")
    .update({ reminded_at: nowIso })
    .is("reminded_at", null).eq("done", false).lte("remind_at", nowIso).gte("remind_at", cutoff)
    .select("id,user_id,date,start_time,end_time,title,memo");
  if (e1) out.errors.push("events: " + e1.message);
  for (const ev of evs ?? []) {
    out.events++;
    const when = ev.start_time ? `${ev.start_time}${ev.end_time ? "–" + ev.end_time : ""}` : "종일";
    const md = `${Number(ev.date.slice(5, 7))}/${Number(ev.date.slice(8, 10))}`;
    const r = await sendTo(sb, ev.user_id, {
      title: `📌 ${ev.title}`, body: `${md} ${when}${ev.memo ? " · " + ev.memo : ""}`,
      url: `./?tab=home&date=${ev.date}`, tag: `ev:${ev.id}`,
    }, cache);
    out.ok += r.ok; out.removed += r.removed; out.errors.push(...r.errors);
  }

  // 2) 루틴 알림 큐
  const { data: qs, error: e2 } = await sb.from("pds_push_queue")
    .update({ sent_at: nowIso })
    .is("sent_at", null).lte("fire_at", nowIso).gte("fire_at", cutoff)
    .select("user_id,key,kind,date,title,body,url");
  if (e2) out.errors.push("queue: " + e2.message);
  for (const q of qs ?? []) {
    // 리뷰를 이미 썼으면 리뷰 알림은 건너뜀
    if (q.kind === "review" && q.date) {
      const { data: d } = await sb.from("pds_days").select("data").eq("user_id", q.user_id).eq("date", q.date).maybeSingle();
      if (d?.data?.review?.at) { out.skipped++; continue; }
    }
    out.routines++;
    const r = await sendTo(sb, q.user_id, { title: q.title, body: q.body, url: q.url, tag: q.key }, cache);
    out.ok += r.ok; out.removed += r.removed; out.errors.push(...r.errors);
  }

  // 정리: 3일 지난 큐 기록 삭제
  if (now.getUTCMinutes() === 0) await sb.from("pds_push_queue").delete().lt("fire_at", new Date(now.getTime() - 3 * 864e5).toISOString());
  return json(out);
});
