'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { GameEngine } = require('../game/engine');
const { LINEUP, RULES } = require('../game/constants');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mk(seed = 42) {
  const e = new GameEngine({ rng: mulberry32(seed) });
  e.startGame();
  e.drainEvents();
  return e;
}

function step(e, ms) {
  for (let t = 0; t < ms; t += 50) e.update(50);
}

// 투구 후 플레이트 위치를 강제로 지정해 결정적으로 판정시킨다
function throwPitch(e, plate, opts = {}) {
  const side = e.fieldingSide();
  e.handlePitch(side, { kind: 'FOUR', aim: { x: 0, y: 0 }, power: 1 });
  assert.strictEqual(e.phase, 'PITCH_LIVE');
  e.currentPitch.plate = plate;
  return e.currentPitch.flightMs;
}

function takePitch(e, plate) {
  const fl = throwPitch(e, plate);
  step(e, RULES.windupMs + fl + 400); // 와인드업 + 비행 + 유예 경과 → 심판 판정
}

test('볼넷: 존 밖 4구 → 1루 출루, 카운트 리셋', () => {
  const e = mk();
  for (let i = 0; i < 4; i++) takePitch(e, { x: 1.7, y: 0 });
  assert.strictEqual(e.bases[1], 0, '타자(타순1)가 1루에');
  assert.strictEqual(e.balls, 0);
  assert.strictEqual(e.batterIdx.away, 1);
  assert.strictEqual(e.phase, 'PITCHING');
});

test('밀어내기 볼넷: 만루에서 볼넷 → 1득점', () => {
  const e = mk();
  e.bases = [null, 6, 5, 4];
  for (let i = 0; i < 4; i++) takePitch(e, { x: 1.7, y: 0 });
  assert.strictEqual(e.totalRuns('away'), 1);
  assert.deepStrictEqual(e.bases.slice(1), [0, 6, 5]);
});

test('삼진: 존 안 3구 루킹 → 아웃', () => {
  const e = mk();
  for (let i = 0; i < 3; i++) takePitch(e, { x: 0, y: 0 });
  assert.strictEqual(e.outs, 1);
  assert.strictEqual(e.batterIdx.away, 1);
});

test('파울은 2스트라이크에서 카운트 증가 없음', () => {
  const e = mk();
  e.foulBall(false); e.foulBall(false); e.foulBall(false); e.foulBall(false);
  assert.strictEqual(e.strikes, 2);
  assert.strictEqual(e.outs, 0);
});

test('번트 파울은 2스트라이크에서 삼진', () => {
  const e = mk();
  e.strikes = 2;
  e.foulBall(true);
  assert.strictEqual(e.outs, 1);
});

test('헛스윙: 타이밍 크게 빗나가면 스트라이크', () => {
  const e = mk();
  const fl = throwPitch(e, { x: 0, y: 0 });
  e.handleSwing('away', { aim: { x: 0, y: 0 }, dt: Math.max(0, RULES.windupMs + fl - 250) });
  assert.strictEqual(e.strikes, 1);
  assert.strictEqual(e.phase, 'PITCHING');
});

test('정타: 정확한 위치+타이밍 스윙 → 인플레이', () => {
  const e = mk();
  const fl = throwPitch(e, { x: 0, y: 0 });
  e.handleSwing('away', { aim: { x: 0, y: 0 }, dt: RULES.windupMs + fl });
  assert.strictEqual(e.phase, 'LIVE');
  const snap = e.getSnapshot();
  assert.ok(snap.runners.some(r => r.isBatter), '타자주자 생성');
  assert.strictEqual(snap.fielders.length, 9);
});

test('홈런: 큰 타구 → 전 주자 득점, 안타 기록', () => {
  const e = mk();
  e.bases = [null, 3, null, 1]; // 1,3루
  e.startLive(180, 30, 0, false, 1);
  step(e, 12000);
  assert.strictEqual(e.phase, 'PITCHING');
  assert.strictEqual(e.totalRuns('away'), 3, '주자2+타자');
  assert.strictEqual(e.hits.away, 1);
  assert.strictEqual(e.outs, 0);
});

test('3아웃 → 공수교대 (MID_INNING 후 말 공격)', () => {
  const e = mk();
  e.outs = 2;
  for (let i = 0; i < 3; i++) takePitch(e, { x: 0, y: 0 }); // 삼진
  assert.strictEqual(e.phase, 'MID_INNING');
  step(e, 3100);
  assert.strictEqual(e.phase, 'PITCHING');
  assert.strictEqual(e.half, 1);
  assert.strictEqual(e.battingSide(), 'home');
  assert.strictEqual(e.outs, 0);
});

test('9회초 종료 시 홈 리드 → 말 공격 없이 경기 종료', () => {
  const e = mk();
  e.inning = 9; e.half = 0;
  e.score.away = [0,0,0,0,0,0,0,0]; e.score.home = [1,0,0,0,0,0,0,0];
  e.outs = 3;
  e.endHalfInning();
  assert.strictEqual(e.phase, 'GAME_OVER');
  assert.strictEqual(e.winner, 'home');
});

test('9회말 동점 종료 → 연장 10회', () => {
  const e = mk();
  e.inning = 9; e.half = 1;
  e.score.away = [2,0,0,0,0,0,0,0,0]; e.score.home = [2,0,0,0,0,0,0,0,0];
  e.endHalfInning();
  assert.strictEqual(e.phase, 'MID_INNING');
  assert.strictEqual(e.inning, 10);
  assert.strictEqual(e.half, 0);
});

test('12회말 동점 종료 → 무승부', () => {
  const e = mk();
  e.inning = 12; e.half = 1;
  e.score.away = Array(12).fill(0); e.score.home = Array(12).fill(0);
  e.endHalfInning();
  assert.strictEqual(e.phase, 'GAME_OVER');
  assert.strictEqual(e.winner, null);
});

test('끝내기: 9회말 밀어내기 볼넷 → 즉시 경기 종료', () => {
  const e = mk();
  e.inning = 9; e.half = 1;
  e.score.away = Array(9).fill(0); e.score.home = Array(8).fill(0);
  e.bases = [null, 6, 5, 4];
  for (let i = 0; i < 4; i++) takePitch(e, { x: 1.7, y: 0 });
  assert.strictEqual(e.phase, 'GAME_OVER');
  assert.strictEqual(e.winner, 'home');
});

// ---- 인플레이 시뮬레이션 (수비 입력 스크립트로 구동) ----

function driveDefense(e, plan) {
  // plan: 홀더가 되면 순서대로 송구할 베이스 목록
  const side = e.fieldingSide();
  let throwIdx = 0;
  let lastHolder = -1;
  for (let t = 0; t < 20000 && e.phase === 'LIVE'; t += 50) {
    const L = e.live;
    if (L.ball.holder >= 0 && L.ball.holder === L.ctrl) {
      if (L.ball.holder !== lastHolder && throwIdx < plan.length) {
        e.handleThrow(side, plan[throwIdx++]);
      }
      lastHolder = L.ball.holder;
    } else {
      lastHolder = -1;
      // 조작 야수를 공 쪽으로 이동
      const f = L.fielders[L.ctrl];
      const dx = L.ball.x - f.x, dy = L.ball.y - f.y;
      const m = Math.hypot(dx, dy) || 1;
      e.handleMove(side, { x: dx / m, y: dy / m });
    }
    e.update(50);
  }
}

test('땅볼 → 1루 송구 포스아웃', () => {
  const e = mk(7);
  e.startLive(95, 0, -20, false, 0.5); // 유격수 방면 땅볼
  driveDefense(e, [1]);
  assert.strictEqual(e.phase, 'PITCHING', '플레이 종료');
  assert.strictEqual(e.outs, 1, '타자 포스아웃');
  assert.strictEqual(e.hits.away, 0, '안타 아님');
});

test('병살: 1루 주자 + 땅볼 → 2루-1루 연결', () => {
  const e = mk(11);
  e.bases = [null, 7, null, null]; // 1루: 8번(느림)
  e.batterIdx.away = 3;            // 타자: 4번 강대포(주력3) — 준족이면 1루 세이프가 정상
  e.startLive(95, 0, -20, false, 0.5);
  driveDefense(e, [2, 1]);
  const evs = e.drainEvents();
  assert.strictEqual(e.outs, 2, '더블플레이');
  assert.ok(evs.some(ev => ev.t === 'splash' && ev.text === 'DOUBLE PLAY!'), 'DP 스플래시');
});

test('희생플라이: 외야 플라이 포구 → 3루주자 태그업 득점', () => {
  const e = mk(3);
  e.bases = [null, null, null, 0]; // 3루: 1번(빠름)
  e.startLive(120, 45, 0, false, 0.8);
  // 중견수 근처로 낙하 직전 상태를 만들어 포구를 결정적으로
  const L = e.live;
  L.ball.x = 0; L.ball.y = 246; L.ball.z = 8; L.ball.vz = -30; L.ball.vx = 0; L.ball.vy = 0;
  e.update(50);
  assert.ok(L.caughtFly, '플라이 포구');
  assert.ok(L.batterOut, '타자 아웃');
  e.handleRun('away', { cmd: 'go' }); // 잘못된 형태 — 무시되어야 함
  e.handleRun('away', 'go'); // 태그업!
  step(e, 6000);
  assert.strictEqual(e.totalRuns('away'), 1, '태그업 득점');
  assert.strictEqual(e.outs, 1);
  assert.match(e.lastPlaySummary, /희생플라이/);
});

test('주루 정지(stop) 명령으로 귀루', () => {
  const e = mk(5);
  e.bases = [null, null, 1, null]; // 2루 주자
  e.startLive(120, 45, 0, false, 0.8); // 플라이 (주자 홀드)
  e.handleRun('away', 'go');   // 주자 3루로 출발
  step(e, 300);
  const r = e.live.runners.find(rr => !rr.isBatter);
  assert.strictEqual(r.state, 'run');
  e.handleRun('away', 'stop'); // 귀루
  assert.strictEqual(r.state, 'return');
  step(e, 2000);
  assert.strictEqual(r.state, 'onbase');
});

test('투수 교체는 1회만 가능, 스태미나 회복', () => {
  const e = mk();
  e.stamina.home = 10;
  e.handleSwap('home');
  assert.strictEqual(e.pitcherIdx.home, 1);
  assert.ok(e.stamina.home > 10);
  e.handleSwap('home'); // 무시
  assert.strictEqual(e.pitcherIdx.home, 1);
});

test('스냅샷 형식: LIVE 중 공/야수/주자 좌표 제공', () => {
  const e = mk();
  e.startLive(120, 30, 10, false, 0.7);
  e.update(50);
  const s = e.getSnapshot();
  assert.ok(typeof s.ball.x === 'number' && typeof s.ball.z === 'number');
  assert.strictEqual(s.fielders.length, 9);
  assert.ok(s.runners.length >= 1);
  assert.ok(s.ctrl >= 0 && s.ctrl < 9);
});

test('라인업 데이터 무결성: 9명, 포지션 중복 없음', () => {
  assert.strictEqual(LINEUP.length, 9);
  const poss = new Set(LINEUP.map(l => l.pos));
  assert.strictEqual(poss.size, 9);
});
