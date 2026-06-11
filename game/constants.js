'use strict';

// 필드 좌표계: 홈플레이트 원점(0,0), 단위 ft, +y = 센터 방향, +x = 1루 방향(우측)
const BASE_DIST = 90;
const D = BASE_DIST / Math.SQRT2; // 63.64

const FIELD = {
  bases: [
    { x: 0, y: 0 },     // 0 = 홈
    { x: D, y: D },     // 1루
    { x: 0, y: 2 * D }, // 2루
    { x: -D, y: D },    // 3루
  ],
  mound: { x: 0, y: 59 },
  // 펜스: 파울폴 ~318ft → 센터 388ft, 높이 10ft (밸런스 측정으로 단축 — CLAUDE.md)
  fenceHeight: 10,
  fenceParams: { c: 388, drop: 70, exp: 1.2 },
  fenceDist(sprayDeg) {
    const a = Math.min(Math.abs(sprayDeg), 45) / 45;
    const F = this.fenceParams;
    return F.c - F.drop * Math.pow(a, F.exp);
  },
  foulDeg: 45,
};

// 수비 기본 위치 (포지션 인덱스 = 라인업과 무관, posIdx 0..8)
const POSITIONS = [
  { key: 'P',  x: 0,    y: 57 },
  { key: 'C',  x: 0,    y: -8 },
  { key: '1B', x: 72,   y: 78 },
  { key: '2B', x: 38,   y: 118 },
  { key: '3B', x: -72,  y: 78 },
  { key: 'SS', x: -38,  y: 118 },
  { key: 'LF', x: -105, y: 210 },
  { key: 'CF', x: 0,    y: 245 },
  { key: 'RF', x: 105,  y: 210 },
];
// 각 포지션이 커버하는 베이스 (송구 수신/베이스 커버 AI용)
const COVER_BASE = { P: 0, C: 0, '1B': 1, '2B': 2, '3B': 3, SS: 2, LF: -1, CF: -1, RF: -1 };

// 라인업: 양 팀 동일 (밸런스 우선). pow/con/spd 1..10, def = 수비력(송구/포구)
// pos = 수비 포지션 인덱스(POSITIONS)
const LINEUP = [
  { name: '한질풍', pos: 7, pow: 3, con: 7, spd: 9, def: 8 }, // 1번 CF 주력형
  { name: '나밀어', pos: 3, pow: 4, con: 8, spd: 7, def: 7 }, // 2번 2B 컨택형
  { name: '오정교', pos: 8, pow: 7, con: 7, spd: 5, def: 7 }, // 3번 RF 밸런스
  { name: '강대포', pos: 2, pow: 9, con: 6, spd: 3, def: 6 }, // 4번 1B 파워형
  { name: '마장타', pos: 6, pow: 8, con: 6, spd: 4, def: 6 }, // 5번 LF
  { name: '백삼루', pos: 4, pow: 6, con: 6, spd: 5, def: 7 }, // 6번 3B
  { name: '유유격', pos: 5, pow: 4, con: 7, spd: 7, def: 9 }, // 7번 SS 수비형
  { name: '안방쇠', pos: 1, pow: 5, con: 5, spd: 3, def: 8 }, // 8번 C
  { name: '투수다', pos: 0, pow: 2, con: 4, spd: 4, def: 6 }, // 9번 P
];

// 투수: velo/ctrl 1..10, stam = 시작 스태미나
const PITCHERS = [
  { name: '선발 강철완', velo: 8, ctrl: 7, stam: 100 },
  { name: '불펜 광속구', velo: 9, ctrl: 5, stam: 60 },
];

// 구종: flightMs = 기준 비행시간(파워/스태미나로 변동), break = 존 좌표 단위 무브먼트
// ctrlMul = 제구 난이도 (커브/슬라이더는 제구 어려움)
// flightMs는 사람 반응속도(인지 150~250ms + 마우스 조준) 기준으로 밸런싱.
// tools/balance-sim.js 측정 결과로 조정 — 빠르게 만들수록 컨택률이 급락한다.
const PITCH_KINDS = {
  FOUR:   { label: '직구',    flightMs: 560, breakX: 0,     breakY: -0.10, ctrlMul: 1.0 },
  SLIDER: { label: '슬라이더', flightMs: 650, breakX: 0.55,  breakY: 0.15,  ctrlMul: 1.25 },
  CURVE:  { label: '커브',    flightMs: 720, breakX: 0.15,  breakY: 0.75,  ctrlMul: 1.3 },
  CHANGE: { label: '체인지업', flightMs: 760, breakX: -0.10, breakY: 0.35,  ctrlMul: 1.1 },
};

// 존 좌표: x,y ∈ [-1,1]이 스트라이크존. 공 반경 보정 1.12까지 스트라이크.
const ZONE_EDGE = 1.12;

const RULES = {
  innings: 9,
  maxInnings: 12, // 이후 무승부
  ticksPerSec: 20,
  tickMs: 50,
  swingGraceMs: 400,  // 레이턴시 유예 (핑 + 늦은 스윙 꼬리까지 흡수)
  windupMs: 500,      // 투구 와인드업 연출 (판정 시계에 포함 — 클라/서버 동기 기준)
  rejoinGraceMs: 30000,
  midInningMs: 3000,
  playTimeoutMs: 25000,
  staminaLow: 30,
};

module.exports = { FIELD, POSITIONS, COVER_BASE, LINEUP, PITCHERS, PITCH_KINDS, ZONE_EDGE, RULES, BASE_DIST };
