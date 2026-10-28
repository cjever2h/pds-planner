// 기본 데이터: 네오님 루틴 문서(3대 관리 영역 · 평일/주말 루틴 · 원시인 버튼)를 그대로 옮긴 초기값
// 설정 탭에서 언제든 수정할 수 있고, 수정본은 계정(Supabase)에 저장됩니다.

export const AREAS = {
  run:   { label: '런닝',   color: '#f97316' },
  read:  { label: '독서',   color: '#3b82f6' },
  biz:   { label: '사업',   color: '#8b5cf6' },
  work:  { label: '업무',   color: '#64748b' },
  life:  { label: '생활',   color: '#10b981' },
  review:{ label: '리뷰',   color: '#f59e0b' },
};

// days: 0=일 1=월 ... 6=토
const WD = [1, 2, 3, 4, 5];
const WE = [0, 6];
let n = 0;
const b = (start, end, title, area, days, note = '') => ({ id: 't' + (++n), start, end, title, area, days, note });

export const DEFAULT_TEMPLATE = [
  // 평일
  b('05:20', '05:30', '기상', 'life', WD, '22:30 취침 → 05:20 기상'),
  b('05:30', '06:40', '런닝', 'run', [2, 4], '화·목 런닝'),
  b('05:30', '06:40', '보강운동 (푸시업 프로그램)', 'run', [1, 3, 5], '월·수·금 보강'),
  b('06:40', '07:00', '샤워 · 스트레칭', 'life', WD, '냉수샤워 = 원시인 ⑦'),
  b('07:00', '07:30', '아침 단식', 'life', [1, 5], '월·금 단식'),
  b('07:00', '07:30', '아침식사 (단백질식사)', 'life', [2, 3, 4], '화·수·목 단백질식사'),
  b('07:30', '08:20', '✍️ 글쓰기 골든타임', 'biz', WD, '알림 차단 필수'),
  b('08:35', '10:00', '출근 이동 (독서)', 'read', WD, ''),
  b('10:00', '19:00', '업무 (KTIS 콜센터)', 'work', WD, ''),
  b('13:40', '14:00', '점심 후 산책', 'life', WD, '원시인 ⑤ 걷기'),
  b('21:30', '21:40', '하루 리뷰 (See)', 'review', WD, ''),
  b('21:40', '22:10', '📚 독서 (전자기기 차단)', 'read', WD, ''),
  b('22:30', '22:40', '취침', 'life', WD, ''),
  // 주말
  b('05:20', '05:30', '기상', 'life', WE, ''),
  b('05:30', '07:00', '인터벌 런닝', 'run', [6], '토요일 인터벌 = 원시인 ⑨'),
  b('05:30', '07:00', 'LSD 런닝', 'run', [0], ''),
  b('07:30', '08:00', '아침식사', 'life', WE, ''),
  b('09:00', '10:30', '💼 온라인사업 집중', 'biz', WE, ''),
  b('12:30', '13:30', '점심 (요리도전)', 'life', WE, ''),
  b('13:30', '14:30', '집 청소', 'life', WE, ''),
  b('17:00', '18:00', '📚 독서', 'read', WE, ''),
  b('21:30', '21:40', '하루 리뷰 (See)', 'review', [6], ''),
  b('21:30', '21:40', '하루 리뷰 + 주간 리뷰', 'review', [0], '일요일은 주간 리뷰도'),
  b('21:40', '22:10', '독서', 'read', WE, ''),
  b('22:30', '22:40', '취침', 'life', WE, ''),
];

// 원시인 버튼 스캔: 평일 1~8 (8점), 주말 1~15 (15점). Y가 아니면 자동 N.
export const DEFAULT_CAVEMAN = [
  { no: 1, name: '수면', hint: '22:30 취침 → 05:30 기상', weekend: false },
  { no: 2, name: '물', hint: '2L 이상', weekend: false },
  { no: 3, name: '호흡', hint: '윔호프 10분', weekend: false },
  { no: 4, name: '햇빛', hint: '기상 직후 운동', weekend: false },
  { no: 5, name: '걷기', hint: '점심 후 10분', weekend: false },
  { no: 6, name: '영양', hint: '요일별 식단', weekend: false },
  { no: 7, name: '불편함', hint: '냉수샤워', weekend: false },
  { no: 8, name: '근력', hint: '운동 10분+', weekend: false },
  { no: 9, name: '고강도', hint: '인터벌 런닝 (토요일 전용)', weekend: true },
  { no: 10, name: '부족', hint: '친구 3명 교류', weekend: true },
  { no: 11, name: '대면', hint: '폰 없이 대화 10분', weekend: true },
  { no: 12, name: '기여', hint: '헌혈 / 자원봉사', weekend: true },
  { no: 13, name: '친밀감', hint: '', weekend: true },
  { no: 14, name: '여백', hint: '멍때리기 10분', weekend: true },
  { no: 15, name: '몰입', hint: '한 달 1주제', weekend: true },
];

// 매일 SNS 체크리스트
export const DEFAULT_SNS = [
  { key: 'th_post', label: '스레드 글', target: 7, unit: '개', days: [0, 1, 2, 3, 4, 5, 6] },
  { key: 'th_reply', label: '스레드 댓글', target: 40, unit: '개', days: [0, 1, 2, 3, 4, 5, 6] },
  { key: 'ig_reply', label: '인스타 댓글', target: 10, unit: '개', days: [0, 1, 2, 3, 4, 5, 6] },
  { key: 'ig_post', label: '인스타 포스팅', target: 1, unit: '건', days: [1, 3, 5] },
];

// 병렬독서 4트랙
export const DEFAULT_TRACKS = [
  { id: 'personal', name: '개인독서', book: '', total: 0, page: 0, action: '' },
  { id: 'dokgimo', name: '독기모', book: '', total: 0, page: 0, action: '' },
  { id: 'rich', name: '부자의 서재', book: '', total: 0, page: 0, action: '' },
  { id: 'brick', name: 'BRICK READERS', book: '', total: 0, page: 0, action: '' },
];

export function defaultProfile() {
  return {
    template: structuredClone(DEFAULT_TEMPLATE),
    caveman: structuredClone(DEFAULT_CAVEMAN),
    sns: structuredClone(DEFAULT_SNS),
    tracks: structuredClone(DEFAULT_TRACKS),
    books: [], // 완독 기록 [{id, title, track, date}]
    monthlyBooks: 7,
    race: { name: '서울레이스 (JTBC 서울마라톤)', date: '2026-11-01', goal: '서브 3:40' },
    links: {
      runningApp: 'https://running-calendar-zeta.vercel.app',
      readingApp: 'https://reading-app-beige.vercel.app',
    },
    reviewTime: '21:30',
    // 알림 설정 (설정 탭 > 알림). push=한 기기라도 웹푸시를 켜면 true → 앱이 14일치 루틴 알림을 서버에 예약
    notify: {
      push: false,
      eventDefault: '10',          // 새 일정 기본 알림: none | 0 | 10 | 30 | 60 | 1440 | eve
      allDayTime: '09:00',         // 종일 일정의 기준 시각 (정각/…분 전 계산용)
      blockOn: true,
      blockLead: '5',              // 블록 시작 몇 분 전
      blockAreas: ['run', 'biz', 'read'],
      planOn: true, planTime: '06:50',
      reviewOn: true,              // 시각은 reviewTime
      focusOn: true,
    },
  };
}

export const SCORE_HELP = 'PDS 점수 = 블록 실행률 · 원시인 버튼 · 핵심 3 · SNS 달성률의 평균 (값이 있는 항목만)';
