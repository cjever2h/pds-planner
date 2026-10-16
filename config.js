// Supabase 연결 정보 (publishable 키는 공개용 키입니다. 데이터는 RLS 정책으로 본인만 접근 가능)
// 런닝 캘린더와 같은 프로젝트를 써서 같은 계정으로 로그인하고, 오늘 훈련·대회 D-day를 함께 보여줍니다.
// 비워두면 브라우저 localStorage에 저장하는 로컬 모드로 동작합니다.
export const SUPABASE_URL = 'https://gcnfvcbatpohhctitnkl.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_8zyr4Cia8y1JiVOguUC12Q_ZOknEH3F';

// 독서앱(별도 Supabase 프로젝트) — 읽기 전용 연동. 독서앱 계정으로 한 번 연결하면 책·쪽수·독서 시간·실행 실험·복습을 불러옵니다.
export const READING_URL = 'https://rdwizwmqkkgbulwjlsco.supabase.co';
export const READING_KEY = 'sb_publishable_jTlLZWpD_c989ZW95CjPhQ_JYhJPJFX';
