'use strict';
// 투타 밸런스 측정 시뮬레이터
//   node tools/balance-sim.js [games=10] [seed=1]
//
// 사람을 모사한 봇 2개로 풀게임을 돌리고 목표 지표와 비교한다.
//   타자 봇: 반응 지연 + 구속 읽기 오차(빠를수록 큼) + 모터 조준 오차 +
//            "평균 구속에 적응" 타이밍 모델 (체인지업에 빠른 스윙, 직구에 늦은 스윙)
//   투수 봇: 존 구석 60% / 유인구 40%, 게이지 정점 근처 릴리스
//   수비 봇: 조작 야수를 공으로 이동, 포구 시 선행 주자 베이스로 송구

const { GameEngine } = require('../game/engine');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class HumanBatterBot {
  constructor(rng) {
    this.rng = rng;
    this.expFlight = 520; // 체감 평균 구속(비행시간)에 적응
  }
  // pitchStart 시점에 스윙 계획을 세운다. null = 지켜봄
  plan(cp, windup, count) {
    const rng = this.rng;
    const flight = cp.flightMs;
    // 인지: 궤적을 읽고 도달점을 추정 (빠른 공일수록 부정확)
    const sigmaP = 0.30 + 0.18 * (500 / flight);
    const px = cp.plate.x + gauss(rng) * sigmaP;
    const py = cp.plate.y + gauss(rng) * sigmaP;
    // 스윙 판단 (보더라인 추격 포함)
    const m = Math.max(Math.abs(px), Math.abs(py));
    let pSwing = m <= 1.0 ? 0.80 : m <= 1.25 ? 0.42 : m <= 1.6 ? 0.15 : 0.05;
    if (count.s === 2) pSwing = Math.min(1, pSwing * 1.4 + 0.08); // 2스트라이크 방어 스윙
    if (count.b === 3 && m > 1.0) pSwing *= 0.45;                  // 풀카운트 골라내기
    if (rng() > pSwing) return null;
    // 타이밍: 평균 구속 기준으로 계획하고 비행 중 55%만 보정 → 오프스피드에 속음
    const planned = windup + 0.45 * this.expFlight + 0.55 * flight;
    let dt = planned + gauss(rng) * 75 + 8;
    if (rng() < 0.10) dt += (rng() < 0.5 ? -1 : 1) * (120 + rng() * 120); // 완전히 속은 스윙
    dt = Math.max(dt, windup + 150 + rng() * 100); // 인간 반응 한계 150~250ms
    this.expFlight = this.expFlight * 0.7 + flight * 0.3;
    // 모터 오차 (마우스 미세 조준)
    const aim = { x: px + gauss(rng) * 0.15, y: py + gauss(rng) * 0.15 };
    return { aim, dt, bunt: false };
  }
}

function pitcherPlan(rng, stamina) {
  const kinds = ['FOUR', 'FOUR', 'SLIDER', 'CURVE', 'CHANGE']; // 직구 비중 높게
  const kind = kinds[(rng() * kinds.length) | 0];
  let aim;
  if (rng() < 0.6) { // 존 안 구석
    aim = { x: (rng() * 2 - 1) * 0.95, y: (rng() * 2 - 1) * 0.95 };
  } else { // 존 바로 바깥 유인구
    const edge = 1.05 + rng() * 0.3;
    aim = rng() < 0.5 ? { x: (rng() < 0.5 ? -1 : 1) * edge, y: (rng() * 2 - 1) * 0.8 }
                      : { x: (rng() * 2 - 1) * 0.8, y: (rng() < 0.5 ? -1 : 1) * edge };
  }
  const power = Math.max(0.3, Math.min(1, 1 - Math.abs(gauss(rng)) * 0.18));
  return { kind, aim, power };
}

function throwDecision(e, L) { // 사람 흉내: 잡을 수 있는 포스 선행주자 > 1루 > 달리는 주자
  const running = L.runners.filter(r => !r.out && !r.scored && r.state === 'run');
  if (!running.length) return null;
  const forcedLead = running.filter(r => e.isForcedLive(r)).sort((a, b) => b.to - a.to)[0];
  if (forcedLead && forcedLead.prog < 0.6) return Math.min(forcedLead.to, 4);
  const batter = running.find(r => r.isBatter);
  if (batter) return 1;
  const lead = running.sort((a, b) => b.to - a.to)[0];
  return lead.to >= 4 ? 4 : lead.to;
}

function playGame(seed) {
  const rng = mulberry32(seed);
  const e = new GameEngine({ rng: mulberry32(seed + 5000) });
  e.startGame(); e.drainEvents();
  const bats = { away: new HumanBatterBot(mulberry32(seed + 11)), home: new HumanBatterBot(mulberry32(seed + 22)) };
  const S = {
    swings: 0, whiffs: 0, fouls: 0, inplay: 0,
    K: { away: 0, home: 0 }, BB: { away: 0, home: 0 }, HR: 0, SF: { away: 0, home: 0 },
  };
  let swingPlan = null, pitchT = 0, swungThis = false, thrownOnce = false;

  const MAX = 20 * 60 * 200;
  let ticks = 0;
  while (e.phase !== 'GAME_OVER' && ticks < MAX) {
    const fs = e.fieldingSide(), bs = e.battingSide();
    if (e.phase === 'PITCHING') {
      if (e.stamina[fs] < 25 && !e.swapUsed[fs]) e.handleSwap(fs);
      e.handlePitch(fs, pitcherPlan(rng, e.stamina[fs]));
      const cp = e.currentPitch;
      swingPlan = bats[bs].plan(cp, 500, { b: e.balls, s: e.strikes });
      pitchT = 0; swungThis = false;
    } else if (e.phase === 'PITCH_LIVE') {
      pitchT += 50;
      if (swingPlan && !swungThis && pitchT >= swingPlan.dt) {
        S.swings++;
        e.handleSwing(bs, swingPlan);
        swungThis = true;
      }
    } else if (e.phase === 'LIVE') {
      const L = e.live;
      if (L.ball.holder >= 0 && L.ball.holder === L.ctrl) {
        if (!thrownOnce) {
          const base = throwDecision(e, L);
          if (base) e.handleThrow(fs, base);
          thrownOnce = true;
        }
      } else {
        thrownOnce = false;
        const f = L.fielders[L.ctrl];
        const tgt = (L.predLand && L.ball.mode === 'fly' && !L.ball.bounced) ? L.predLand : L.ball;
        const dx = tgt.x - f.x, dy = tgt.y - f.y, m = Math.hypot(dx, dy) || 1;
        e.handleMove(fs, { x: dx / m, y: dy / m });
      }
      // 주루 (사람 흉내, 0.5초마다 판단): 공이 멀면 진루, 송구 비행 중이면 멈춤, 포구 후 태그업
      if (ticks % 10 === 0) {
        const ballR = Math.hypot(L.ball.x, L.ball.y);
        const holderDeep = L.ball.holder >= 0 && L.fielders[L.ball.holder].y > 150;
        if (L.caughtFly) {
          if (rng() < 0.6) e.handleRun(bs, 'go'); // 태그업 시도
        } else if (L.ball.bounced && ((L.ball.holder < 0 && ballR > 120) || holderDeep)) {
          if (rng() < 0.55) e.handleRun(bs, 'go');
        } else if (L.ball.mode === 'thrown' && rng() < 0.6) {
          e.handleRun(bs, 'stop');
        }
      }
    }
    e.update(50);
    for (const ev of e.drainEvents()) {
      if (ev.t === 'pitchResult' && swungThis) {
        if (ev.result === 'whiff') S.whiffs++;
        else if (ev.result === 'foul') S.fouls++;
        else if (ev.result === 'inPlay') S.inplay++;
        swungThis = false; // 결과 1회만 집계
      }
      if (ev.t === 'splash') {
        if (ev.text === 'STRIKEOUT!') S.K[bs]++;
        if (ev.text === 'BALL FOUR') S.BB[bs]++;
        if (ev.text === 'HOME RUN!') S.HR++;
        if (ev.text === 'SAC FLY!') S.SF[bs]++;
      }
    }
    ticks++;
  }
  const res = {
    finished: e.phase === 'GAME_OVER',
    innings: e.inning,
    runs: e.totalRuns('away') + e.totalRuns('home'),
    H: { away: e.hits.away, home: e.hits.home },
    E: e.errors.away + e.errors.home,
    PA: { away: e.batterIdx.away, home: e.batterIdx.home },
    ...S,
    minutes: Math.round(ticks / 20 / 60),
  };
  for (const s of ['away', 'home']) {
    const ab = res.PA[s] - res.BB[s] - res.SF[s];
    res['BA_' + s] = ab > 0 ? res.H[s] / ab : 0;
  }
  return res;
}

const games = +process.argv[2] || 10;
const seed0 = +process.argv[3] || 1;
const all = [];
for (let i = 0; i < games; i++) all.push(playGame(seed0 + i * 137));

const avg = k => all.reduce((a, g) => a + (typeof k === 'function' ? k(g) : g[k]), 0) / all.length;
const contact = g => g.swings ? (g.fouls + g.inplay) / g.swings : 0;

console.log(`games=${games} (seed ${seed0}~)  완주: ${all.filter(g => g.finished).length}/${games}`);
console.log('지표                      평균     목표');
console.log(`총 득점/경기            ${avg('runs').toFixed(1).padStart(6)}    7~12`);
console.log(`팀 타율                 ${avg(g => (g.BA_away + g.BA_home) / 2).toFixed(3).padStart(6)}    0.230~0.280`);
console.log(`삼진/팀                 ${avg(g => (g.K.away + g.K.home) / 2).toFixed(1).padStart(6)}    6~10`);
console.log(`볼넷/팀                 ${avg(g => (g.BB.away + g.BB.home) / 2).toFixed(1).padStart(6)}    2~5`);
console.log(`홈런/경기               ${avg('HR').toFixed(1).padStart(6)}    1~3`);
console.log(`컨택률(스윙 중 맞음)    ${(avg(contact) * 100).toFixed(0).padStart(5)}%    ≥50%`);
console.log(`(참고) 안타/팀          ${avg(g => (g.H.away + g.H.home) / 2).toFixed(1).padStart(6)}`);
console.log(`(참고) 스윙/경기        ${avg('swings').toFixed(0).padStart(6)}   실책/경기 ${avg('E').toFixed(1)}  경기시간 ${avg('minutes').toFixed(0)}분`);
