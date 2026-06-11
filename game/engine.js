'use strict';

const { FIELD, POSITIONS, COVER_BASE, LINEUP, PITCHERS, PITCH_KINDS, ZONE_EDGE, RULES } = require('./constants');

const G = 32.17;        // ft/s^2
const DRAG_K = 0.0019;  // 타구 공기저항 계수 (400ft 홈런이 나오도록 튜닝)
const SUBSTEPS = 4;

function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.hypot(dx, dy); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

class GameEngine {
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.evq = [];
    this.phase = 'LOBBY';
    this.inning = 1;
    this.half = 0; // 0=초(away 공격), 1=말(home 공격)
    this.outs = 0;
    this.balls = 0;
    this.strikes = 0;
    this.score = { away: [], home: [] };
    this.hits = { away: 0, home: 0 };
    this.errors = { away: 0, home: 0 };
    this.batterIdx = { away: 0, home: 0 };
    this.pitcherIdx = { away: 0, home: 0 };
    this.stamina = { away: PITCHERS[0].stam, home: PITCHERS[0].stam };
    this.pitchCount = { away: 0, home: 0 };
    this.swapUsed = { away: false, home: false };
    this.bases = [null, null, null, null]; // [_,1루,2루,3루] = lineupIdx | null
    this.buntMode = { away: false, home: false };
    this.currentPitch = null;
    this.pitchTimer = 0;
    this.swung = false;
    this.midTimer = 0;
    this.live = null;
    this.winner = null;
    this.lastPlaySummary = '플레이 볼!';
  }

  // ---------- 공통 ----------
  emit(t, data) { this.evq.push(Object.assign({ t }, data)); }
  drainEvents() { const q = this.evq; this.evq = []; return q; }
  randn() { // 표준정규 (Box-Muller)
    let u = 0, v = 0;
    while (u === 0) u = this.rng();
    while (v === 0) v = this.rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  battingSide() { return this.half === 0 ? 'away' : 'home'; }
  fieldingSide() { return this.half === 0 ? 'home' : 'away'; }
  batter() { return LINEUP[this.batterIdx[this.battingSide()] % 9]; }
  pitcher() { return PITCHERS[this.pitcherIdx[this.fieldingSide()]]; }
  totalRuns(side) { return this.score[side].reduce((a, b) => a + b, 0); }

  startGame() {
    this.phase = 'PITCHING';
    this.emit('state', { state: this.getFullState() });
  }

  getFullState() {
    return {
      phase: this.phase,
      inning: this.inning,
      half: this.half,
      outs: this.outs,
      balls: this.balls,
      strikes: this.strikes,
      score: this.score,
      hits: this.hits,
      errors: this.errors,
      bases: this.bases.map(b => b !== null),
      battingSide: this.battingSide(),
      batter: { idx: this.batterIdx[this.battingSide()] % 9, order: this.batterIdx[this.battingSide()] % 9 + 1 },
      pitcher: {
        idx: this.pitcherIdx[this.fieldingSide()],
        stamina: Math.round(this.stamina[this.fieldingSide()]),
        count: this.pitchCount[this.fieldingSide()],
      },
      swapUsed: this.swapUsed,
      winner: this.winner,
      lastPlay: this.lastPlaySummary,
    };
  }

  // ---------- 메인 루프 ----------
  update(dtMs) {
    if (this.phase === 'PITCH_LIVE') {
      this.pitchTimer -= dtMs;
      if (this.pitchTimer <= 0 && !this.swung) this.judgeTake();
    } else if (this.phase === 'LIVE') {
      this.tickLive(dtMs);
    } else if (this.phase === 'MID_INNING') {
      this.midTimer -= dtMs;
      if (this.midTimer <= 0) {
        this.phase = 'PITCHING';
        this.emit('state', { state: this.getFullState() });
      }
    }
  }

  // ---------- 투구 ----------
  handleSwap(side) {
    if (this.phase !== 'PITCHING' || side !== this.fieldingSide()) return;
    if (this.swapUsed[side] || this.pitcherIdx[side] !== 0) return;
    this.swapUsed[side] = true;
    this.pitcherIdx[side] = 1;
    this.stamina[side] = PITCHERS[1].stam;
    this.pitchCount[side] = 0;
    this.emit('splash', { text: '투수 교체', sub: PITCHERS[1].name, side });
    this.emit('state', { state: this.getFullState() });
  }

  handlePitch(side, p) {
    if (this.phase !== 'PITCHING' || side !== this.fieldingSide()) return;
    const kind = PITCH_KINDS[p.kind];
    if (!kind) return;
    const power = clamp(+p.power || 0, 0, 1);
    const aimX = clamp(+p.aim.x || 0, -1.6, 1.6);
    const aimY = clamp(+p.aim.y || 0, -1.6, 1.6);
    const pc = this.pitcher();
    const st = this.stamina[side];
    const tired = st < RULES.staminaLow;
    // 제구: 파워게이지 빗나감 + 구종 난이도 + 제구 스탯 + 피로
    const ctrlErr = 0.07 * (11 - pc.ctrl) * kind.ctrlMul * (0.6 + (1 - power) * 2.2) * (tired ? 1.6 : 1);
    const plateX = clamp(aimX + this.randn() * ctrlErr, -1.8, 1.8);
    const plateY = clamp(aimY + this.randn() * ctrlErr, -1.8, 1.8);
    // 구속: 구위 스탯 + 게이지 + 피로
    const speedMul = (0.92 + 0.013 * pc.velo) * (0.95 + 0.07 * power) * (tired ? 0.93 : 1);
    const flightMs = Math.round(kind.flightMs / speedMul);

    this.stamina[side] = Math.max(0, st - (0.9 + power * 0.9));
    this.pitchCount[side]++;
    this.currentPitch = { kind: p.kind, plate: { x: plateX, y: plateY }, flightMs, power };
    this.swung = false;
    this.pitchTimer = RULES.windupMs + flightMs + RULES.swingGraceMs;
    this.phase = 'PITCH_LIVE';
    this.emit('pitchStart', {
      kind: p.kind, plate: { x: plateX, y: plateY },
      breakX: kind.breakX, breakY: kind.breakY, flightMs, windupMs: RULES.windupMs,
      stamina: Math.round(this.stamina[side]), pitchCount: this.pitchCount[side],
    });
  }

  // ---------- 타격 판정 ----------
  judgeTake() { // 스윙 없음 → 심판 판정
    const { plate } = this.currentPitch;
    const inZone = Math.abs(plate.x) <= ZONE_EDGE && Math.abs(plate.y) <= ZONE_EDGE;
    if (inZone) this.addStrike('called');
    else this.addBall();
  }

  handleSwing(side, p) {
    if (this.phase !== 'PITCH_LIVE' || side !== this.battingSide() || this.swung) return;
    const { plate, flightMs } = this.currentPitch;
    const total = RULES.windupMs + flightMs; // dt는 pitchStart 수신 기준 → 와인드업 포함
    const dt = +p.dt;
    if (!(dt >= 0 && dt <= total + RULES.swingGraceMs)) return;
    this.swung = true;
    const bunt = !!p.bunt;
    const bat = this.batter();
    const aimX = clamp(+p.aim.x || 0, -2, 2), aimY = clamp(+p.aim.y || 0, -2, 2);
    const terr = dt - total;
    const d = dist2(aimX, aimY, plate.x, plate.y);
    const timingWin = bunt ? 170 : 60 + bat.con * 7;
    const hitWin = bunt ? 1.0 : 0.48 + bat.con * 0.05;

    if (d > hitWin || Math.abs(terr) > timingWin) { this.addStrike('swinging'); return; }
    const q = (1 - d / hitWin) * (1 - Math.abs(terr) / timingWin);
    if (q < 0.1) { // 파울팁
      this.foulBall(bunt);
      return;
    }
    let exitV, la, spray;
    if (bunt) {
      exitV = 22 + q * 18;
      la = -4 + this.randn() * 6;
      spray = (aimX - plate.x) * 35 + this.randn() * 18;
    } else {
      exitV = 55 + q * (52 + bat.pow * 8.5) + this.randn() * 6;
      la = 18 - (aimY - plate.y) * 58 + this.randn() * 8; // 공 위를 치면 땅볼, 아래 받치면 플라이
      spray = terr * 0.5 + (plate.x - aimX) * 18 + this.randn() * 8; // 빠른 스윙=당겨침(좌측)
    }
    la = clamp(la, -14, 64);
    spray = clamp(spray, -65, 65);
    if (Math.abs(spray) > FIELD.foulDeg) { this.foulBall(bunt); return; }
    this.startLive(exitV, la, spray, bunt, q);
  }

  foulBall(bunt) {
    if (bunt && this.strikes >= 2) { // 번트 파울 = 삼진
      this.emit('pitchResult', { result: 'foul', count: this.count() });
      this.strikeOut('번트 파울 삼진');
      return;
    }
    if (this.strikes < 2) this.strikes++;
    this.emit('pitchResult', { result: 'foul', count: this.count() });
    this.backToPitching();
  }

  count() { return { b: this.balls, s: this.strikes, o: this.outs }; }

  addStrike(how) {
    this.strikes++;
    this.emit('pitchResult', { result: how === 'called' ? 'strike' : 'whiff', count: this.count() });
    if (this.strikes >= 3) this.strikeOut(how === 'called' ? '루킹 삼진' : '헛스윙 삼진');
    else this.backToPitching();
  }

  strikeOut(label) {
    this.outs++;
    this.lastPlaySummary = `${this.batter().name} ${label}`;
    this.emit('splash', { text: 'STRIKEOUT!', sub: label });
    this.emit('sound', { kind: 'out' });
    this.endAtBat();
  }

  addBall() {
    this.balls++;
    this.emit('pitchResult', { result: 'ball', count: this.count() });
    if (this.balls >= 4) this.walk();
    else this.backToPitching();
  }

  walk() {
    const side = this.battingSide();
    // 포스 연쇄 진루: 타자 1루, 막힌 주자만 한 베이스씩 밀림
    let carry = this.batterIdx[side] % 9;
    let b = 1;
    while (carry !== null && b <= 3) {
      const occ = this.bases[b];
      this.bases[b] = carry;
      carry = occ;
      b++;
      if (occ === null) carry = null;
    }
    if (carry !== null) this.addRun(1); // 밀어내기 득점
    this.lastPlaySummary = `${this.batter().name} 볼넷`;
    this.emit('splash', { text: 'BALL FOUR', sub: '볼넷 출루' });
    this.endAtBat();
  }

  addRun(n) {
    const side = this.battingSide();
    const arr = this.score[side];
    while (arr.length < this.inning) arr.push(0);
    arr[this.inning - 1] += n;
    this.emit('sound', { kind: 'cheer' });
  }

  backToPitching() {
    this.currentPitch = null;
    this.phase = 'PITCHING';
    this.emit('state', { state: this.getFullState() });
  }

  endAtBat() { // 삼진/볼넷 등 인플레이 없이 타석 종료
    const side = this.battingSide();
    this.batterIdx[side]++;
    this.balls = 0; this.strikes = 0;
    this.currentPitch = null;
    if (this.outs >= 3) this.endHalfInning();
    else {
      this.checkWalkOff();
      if (this.phase !== 'GAME_OVER') {
        this.phase = 'PITCHING';
        this.emit('state', { state: this.getFullState() });
      }
    }
  }

  // ---------- 인플레이 시뮬레이션 ----------
  startLive(exitV, laDeg, sprayDeg, bunt, q) {
    const la = laDeg * Math.PI / 180, sp = sprayDeg * Math.PI / 180;
    const vh = exitV * Math.cos(la);
    const ball = {
      x: 0, y: 1, z: 3,
      vx: vh * Math.sin(sp), vy: vh * Math.cos(sp), vz: exitV * Math.sin(la),
      mode: 'fly', bounced: false, holder: -1,
      throw: null, hr: false,
    };
    const fieldLineup = LINEUP; // 양 팀 동일
    const fielders = POSITIONS.map((pos, i) => {
      const pl = fieldLineup.find(l => l.pos === i);
      return { x: pos.x, y: pos.y, posIdx: i, def: pl.def, speed: 14 + pl.def * 1.5 };
    });
    const side = this.battingSide();
    const isGround = laDeg < 8;
    const runners = [];
    for (let b = 3; b >= 1; b--) {
      if (this.bases[b] !== null) {
        const li = this.bases[b];
        const forced = this.forcedAt(b); // 포스 상태는 타구 종류와 무관
        const auto = isGround && forced;  // 땅볼이면 포스 주자 자동 스타트
        runners.push(this.mkRunner(li, b, auto ? 'run' : 'hold', false, forced));
      }
    }
    runners.push(this.mkRunner(this.batterIdx[side] % 9, 0, 'run', true, true)); // 타자주자
    this.bases = [null, null, null, null];
    this.live = {
      ball, fielders, runners,
      ctrl: -1, ctrlTimer: 0, userDir: { x: 0, y: 0 },
      outsThisPlay: 0, runsThisPlay: 0, errorThisPlay: false,
      caughtFly: false, batterOut: false, batterBase: 0,
      settleTimer: 0, playTimer: 0, hrTimer: 0,
      isGround, bunt,
    };
    this.pickCtrl(true);
    this.phase = 'LIVE';
    this.emit('pitchResult', { result: 'inPlay', count: this.count() });
    this.emit('inPlay', { exitV: Math.round(exitV), la: Math.round(laDeg), spray: Math.round(sprayDeg), q: +q.toFixed(2), bunt });
    this.emit('sound', { kind: bunt || q < 0.45 ? 'tick' : 'crack' });
  }

  forcedAt(base) { // base 주자가 포스 상태인가 (뒤 베이스가 연쇄로 채워짐)
    for (let b = 1; b < base; b++) if (this.bases[b] === null) return false;
    return true;
  }

  mkRunner(lineupIdx, fromBase, state, isBatter = false, forced = false) {
    const pl = LINEUP[lineupIdx];
    return {
      li: lineupIdx, from: fromBase, to: state === 'run' ? fromBase + 1 : fromBase,
      prog: state === 'run' ? 0.02 : 0,
      speed: 21 + pl.spd * 1.2,
      state: state === 'run' ? 'run' : 'onbase',
      isBatter, forced, retouched: true, scored: false, out: false,
    };
  }

  baseXY(b) { const p = FIELD.bases[b % 4]; return p; }

  runnerXY(r) {
    const a = this.baseXY(r.from), b = this.baseXY(r.to);
    return { x: lerp(a.x, b.x, r.prog), y: lerp(a.y, b.y, r.prog) };
  }

  // 공의 미래 경로를 예측해 가장 빨리 인터셉트 가능한 야수를 조작 대상으로 선정
  predictPath() {
    const b = this.live.ball;
    const c = { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, mode: b.mode };
    const pts = [{ x: c.x, y: c.y, t: 0 }];
    const dt = 0.1;
    for (let t = dt; t <= 3.0; t += dt) {
      if (c.mode === 'fly') {
        const v = Math.hypot(c.vx, c.vy, c.vz);
        const k = DRAG_K * v;
        c.vx -= c.vx * k * dt; c.vy -= c.vy * k * dt;
        c.vz -= (G + c.vz * k) * dt;
        c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
        if (c.z <= 0 && c.vz < 0) {
          c.z = 0; c.vz = -c.vz * 0.45; c.vx *= 0.65; c.vy *= 0.65;
          if (c.vz < 4) { c.vz = 0; c.mode = 'rolling'; }
        }
      } else {
        const f = Math.pow(0.45, dt);
        c.vx *= f; c.vy *= f;
        c.x += c.vx * dt; c.y += c.vy * dt;
      }
      pts.push({ x: c.x, y: c.y, t });
    }
    return pts;
  }

  pickCtrl(force) {
    const L = this.live;
    if (L.ball.holder >= 0) { L.ctrl = L.ball.holder; return; }
    if (!force && L.ctrlTimer > 0) return;
    L.ctrlTimer = 500;
    const path = this.predictPath();
    let best = -1, bestCost = 1e9;
    for (let i = 0; i < 9; i++) {
      const f = L.fielders[i];
      let cost = 1e9;
      for (const p of path) {
        const deficit = Math.max(0, dist2(f.x, f.y, p.x, p.y) - f.speed * p.t);
        const c = deficit + p.t * 2; // 같은 조건이면 빨리 닿는 쪽
        if (c < cost) cost = c;
      }
      if (cost < bestCost - 0.01) { bestCost = cost; best = i; }
    }
    L.ctrl = best;
  }

  handleMove(side, dir) {
    if (this.phase !== 'LIVE' || side !== this.fieldingSide()) return;
    const x = clamp(+dir.x || 0, -1, 1), y = clamp(+dir.y || 0, -1, 1);
    const m = Math.hypot(x, y) || 1;
    this.live.userDir = m > 1 ? { x: x / m, y: y / m } : { x, y };
  }

  handleThrow(side, base) {
    if (this.phase !== 'LIVE' || side !== this.fieldingSide()) return;
    const L = this.live, b = +base;
    if (!(b >= 1 && b <= 4)) return;
    if (L.ball.holder < 0 || L.ball.holder !== L.ctrl) return;
    const f = L.fielders[L.ball.holder];
    const tgt = this.baseXY(b);
    const d = dist2(f.x, f.y, tgt.x, tgt.y);
    if (d < 6) return; // 그 베이스에 직접 밟으러 가는 게 맞음
    // 송구 오차: 거리 + 수비력
    const errMag = Math.abs(this.randn()) * d * 0.016 * ((11 - f.def) / 5.5);
    const errAng = this.rng() * Math.PI * 2;
    const dest = { x: tgt.x + Math.cos(errAng) * errMag, y: tgt.y + Math.sin(errAng) * errMag };
    const speed = 95 + f.def * 5;
    L.ball.holder = -1;
    L.ball.mode = 'thrown';
    L.ball.x = f.x; L.ball.y = f.y; L.ball.z = 5.5;
    L.ball.throw = { dest, base: b, speed, errMag, total: dist2(f.x, f.y, dest.x, dest.y), done: 0 };
    L.settleTimer = 0;
    // 제어를 수신 베이스에 가장 가까운 야수로 즉시 이동
    let best = -1, bd = 1e9;
    for (let i = 0; i < 9; i++) {
      const fd = dist2(L.fielders[i].x, L.fielders[i].y, tgt.x, tgt.y);
      if (fd < bd) { bd = fd; best = i; }
    }
    L.ctrl = best; L.ctrlTimer = 600;
    this.emit('sound', { kind: 'whoosh' });
  }

  handleRun(side, cmd) {
    if (this.phase !== 'LIVE' || side !== this.battingSide()) return;
    const L = this.live;
    for (const r of L.runners) {
      if (r.scored || r.out) continue;
      if (cmd === 'go') {
        if (r.state === 'onbase' && r.to < 4 && r.retouched) {
          if (r.to >= 1 && this.runnerAhead(L, r)) continue; // 앞 베이스 점유 시 불가
          r.from = r.to; r.to = r.to + 1; r.prog = 0.02; r.state = 'run';
        } else if (r.state === 'return' && r.prog < 0.5 && r.retouched) {
          // 자발적 귀루만 취소 가능 (리터치 의무 귀루는 불가)
          const f = r.from; r.from = r.to; r.to = f; r.prog = 1 - r.prog; r.state = 'run';
        }
      } else if (cmd === 'stop') {
        if (r.state === 'run' && r.prog < 0.7 && !(r.isBatter && r.to === 1)) {
          const f = r.from; r.from = r.to; r.to = f; r.prog = 1 - r.prog; r.state = 'return';
        }
      }
    }
  }

  runnerAhead(L, r) {
    const next = r.to + 1;
    return L.runners.some(o => o !== r && !o.scored && !o.out &&
      ((o.state === 'onbase' && o.to === next) || (o.state === 'run' && o.to === next) || (o.state === 'return' && o.to === next)));
  }

  tickLive(dtMs) {
    const L = this.live;
    const dt = dtMs / 1000;
    L.playTimer += dtMs;
    L.ctrlTimer -= dtMs;

    if (L.ball.hr) { // 홈런 연출 중
      this.physBall(dt);
      L.hrTimer -= dtMs;
      if (L.hrTimer <= 0) this.resolveHomeRun();
      this.emitSnap();
      return;
    }

    this.physBall(dt);
    if (this.phase !== 'LIVE') return; // 도중 플레이 종료 가능
    this.checkFence();
    this.moveFielders(dt);
    this.tryCatch();
    if (this.phase !== 'LIVE') return;
    this.moveRunners(dt);
    if (this.phase !== 'LIVE') return;
    this.checkOuts();
    if (this.phase !== 'LIVE') return;
    this.checkSettle(dtMs);
    if (this.phase !== 'LIVE') return;
    this.emitSnap();
  }

  physBall(dt) {
    const b = this.live.ball;
    if (b.holder >= 0) {
      const f = this.live.fielders[b.holder];
      b.x = f.x; b.y = f.y; b.z = 4;
      return;
    }
    if (b.mode === 'thrown') {
      const T = b.throw;
      const step = T.speed * dt;
      const dx = T.dest.x - b.x, dy = T.dest.y - b.y;
      const rem = Math.hypot(dx, dy);
      T.done += step;
      // 약한 아크
      const t = clamp(T.done / T.total, 0, 1);
      b.z = 5.5 + Math.sin(t * Math.PI) * Math.min(12, T.total * 0.06);
      if (rem <= step) {
        b.x = T.dest.x; b.y = T.dest.y; b.z = 4;
        this.arriveThrow();
      } else {
        b.x += dx / rem * step; b.y += dy / rem * step;
      }
      return;
    }
    if (b.mode === 'fly') {
      const sdt = dt / SUBSTEPS;
      for (let i = 0; i < SUBSTEPS; i++) {
        const v = Math.hypot(b.vx, b.vy, b.vz);
        const k = DRAG_K * v;
        b.vx -= b.vx * k * sdt; b.vy -= b.vy * k * sdt;
        b.vz -= (G + b.vz * k) * sdt;
        b.x += b.vx * sdt; b.y += b.vy * sdt; b.z += b.vz * sdt;
        if (b.z <= 0 && b.vz < 0) {
          b.z = 0;
          b.vz = -b.vz * 0.45; b.vx *= 0.65; b.vy *= 0.65;
          if (!b.bounced) { b.bounced = true; this.onBallLanded(); }
          if (b.vz < 4) { b.vz = 0; b.mode = 'rolling'; break; }
        }
      }
    } else if (b.mode === 'rolling') {
      b.z = 0;
      const f = Math.pow(0.45, dt);
      b.vx *= f; b.vy *= f;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (Math.hypot(b.vx, b.vy) < 2) { b.vx = 0; b.vy = 0; }
    }
  }

  onBallLanded() { // 첫 바운드: 공이 떨어지면 포스 주자는 반드시 뛰어야 함
    const L = this.live;
    for (const r of L.runners) {
      if (r.forced && r.state === 'onbase' && !r.out && !r.scored && r.from < 4 && !this.runnerAhead(L, r)) {
        r.from = r.to; r.to = r.from + 1; r.prog = 0.02; r.state = 'run';
      }
    }
    this.emit('sound', { kind: 'bounce' });
  }

  checkFence() {
    const b = this.live.ball;
    if (b.holder >= 0 || b.mode === 'thrown') return;
    const r = Math.hypot(b.x, b.y);
    if (r < 200) return;
    const spray = Math.atan2(b.x, b.y) * 180 / Math.PI;
    const fd = FIELD.fenceDist(spray);
    if (r >= fd) {
      if (!b.bounced && b.z > FIELD.fenceHeight) { // 홈런!
        b.hr = true;
        this.live.hrTimer = 2600;
        this.emit('splash', { text: 'HOME RUN!', sub: `${this.batter().name} 비거리 ${Math.round(r)}ft` });
        this.emit('sound', { kind: 'homer' });
      } else { // 펜스 직격 → 안쪽으로 튕김
        const nx = b.x / r, ny = b.y / r;
        const vr = b.vx * nx + b.vy * ny;
        if (vr > 0) { b.vx -= 1.45 * vr * nx; b.vy -= 1.45 * vr * ny; b.vx *= 0.5; b.vy *= 0.5; }
        const pull = fd - 0.5;
        b.x = nx * pull; b.y = ny * pull;
      }
    }
  }

  resolveHomeRun() {
    const L = this.live;
    let runs = 0;
    for (const r of L.runners) if (!r.out && !r.scored) { r.scored = true; runs++; }
    L.runsThisPlay += runs;
    this.addRun(runs);
    this.hits[this.battingSide()]++;
    this.lastPlaySummary = `${this.batter().name} ${runs}점 홈런!`;
    this.finishPlay();
  }

  moveFielders(dt) {
    const L = this.live;
    this.pickCtrl(false);
    const thrown = L.ball.mode === 'thrown';
    for (let i = 0; i < 9; i++) {
      const f = L.fielders[i];
      if (i === L.ctrl && thrown) {
        // 송구 비행 중엔 수신 야수가 목표 지점(베이스)으로 자동 이동 — 유저 입력 무시
        const T = L.ball.throw;
        const dx = T.dest.x - f.x, dy = T.dest.y - f.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.5) { const s = Math.min(f.speed * dt, d); f.x += dx / d * s; f.y += dy / d * s; }
      } else if (i === L.ctrl && L.ball.holder !== i) {
        // 유저 조작
        f.x += L.userDir.x * f.speed * dt;
        f.y += L.userDir.y * f.speed * dt;
      } else if (i === L.ctrl && L.ball.holder === i) {
        f.x += L.userDir.x * f.speed * 0.8 * dt; // 공 들고는 약간 느림
        f.y += L.userDir.y * f.speed * 0.8 * dt;
      } else {
        // AI: 베이스 커버 or 원위치 복귀, 외야수는 공 쪽으로 약간 이동
        const key = POSITIONS[i].key;
        const cover = COVER_BASE[key];
        let tx, ty;
        if (cover >= 1 || key === 'C') {
          const bp = this.baseXY(cover);
          tx = bp.x; ty = bp.y;
        } else if (cover === 0 && key === 'P') {
          tx = POSITIONS[i].x; ty = POSITIONS[i].y;
        } else { // 외야수: 홈 포지션에서 공 쪽으로 절반쯤 백업 이동
          const hx = POSITIONS[i].x, hy = POSITIONS[i].y;
          tx = lerp(hx, L.ball.x, 0.4); ty = lerp(hy, L.ball.y, 0.4);
        }
        const dx = tx - f.x, dy = ty - f.y;
        const d = Math.hypot(dx, dy);
        if (d > 2) {
          const s = Math.min(f.speed * 0.92 * dt, d);
          f.x += dx / d * s; f.y += dy / d * s;
        }
      }
      f.x = clamp(f.x, -260, 260); f.y = clamp(f.y, -20, 420);
    }
  }

  tryCatch() {
    const L = this.live, b = L.ball;
    if (b.holder >= 0 || b.mode === 'thrown' || b.hr) return;
    for (let i = 0; i < 9; i++) {
      const f = L.fielders[i];
      const d = dist2(f.x, f.y, b.x, b.y);
      const reach = i === L.ctrl ? 5 : 4;
      if (b.mode === 'fly' && !b.bounced) {
        if (d < reach && b.z < 9 && b.z > 0.1 && b.vz < 10) { this.flyCaught(i); return; }
      }
      if ((b.mode === 'rolling' || (b.mode === 'fly' && b.bounced)) && d < reach - 0.5 && b.z < 5) {
        b.holder = i; b.mode = 'held'; b.vx = b.vy = b.vz = 0;
        L.ctrl = i;
        this.emit('sound', { kind: 'pop' });
        return;
      }
    }
  }

  flyCaught(idx) {
    const L = this.live, b = L.ball;
    b.holder = idx; b.mode = 'held'; b.vx = b.vy = b.vz = 0;
    L.ctrl = idx;
    L.caughtFly = true;
    this.emit('sound', { kind: 'pop' });
    // 타자 아웃
    const br = L.runners.find(r => r.isBatter);
    if (br && !br.out) { br.out = true; L.outsThisPlay++; L.batterOut = true; this.emit('sound', { kind: 'out' }); }
    // 주자 리터치 의무 → 자동 귀루 (귀루 완료 후 'go'로 태그업 가능)
    for (const r of L.runners) {
      if (r.isBatter || r.out || r.scored) continue;
      if (r.state === 'run') {
        const f = r.from; r.from = r.to; r.to = f; r.prog = 1 - r.prog;
        r.state = 'return'; r.retouched = false;
      }
    }
    this.checkThreeOuts();
  }

  arriveThrow() {
    const L = this.live, b = L.ball;
    const T = b.throw;
    b.throw = null;
    if (T.errMag > 6) { // 악송구! 에러
      this.errors[this.fieldingSide()]++;
      L.errorThisPlay = true;
      b.mode = 'rolling';
      const ang = Math.atan2(b.y, b.x) + (this.rng() - 0.5);
      b.vx = Math.cos(ang) * 25; b.vy = Math.sin(ang) * 25;
      this.emit('splash', { text: 'ERROR!', sub: '악송구' });
      this.emit('sound', { kind: 'boo' });
      this.pickCtrl(true);
      return;
    }
    // 근처 야수가 포구
    let best = -1, bd = 7;
    for (let i = 0; i < 9; i++) {
      const d = dist2(L.fielders[i].x, L.fielders[i].y, b.x, b.y);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      b.holder = best; b.mode = 'held';
      const f = L.fielders[best];
      // 받은 야수를 정확히 베이스에 스냅 (커버 위치)
      if (bd < 4) { b.x = f.x; b.y = f.y; }
      L.ctrl = best;
      this.emit('sound', { kind: 'pop' });
    } else {
      b.mode = 'rolling'; b.vx = 0; b.vy = 0;
      this.pickCtrl(true);
    }
  }

  moveRunners(dt) {
    const L = this.live;
    for (const r of L.runners) {
      if (r.out || r.scored || r.state === 'onbase') continue;
      const a = this.baseXY(r.from), bb = this.baseXY(r.to);
      const len = dist2(a.x, a.y, bb.x, bb.y) || 1;
      r.prog += (r.speed * dt) / len;
      if (r.prog >= 1) {
        r.prog = 1;
        if (r.state === 'return') { // 귀루 완료: to가 돌아온 베이스
          r.state = 'onbase'; r.retouched = true;
          r.from = r.to; r.prog = 0;
        } else if (r.to >= 4) {
          r.scored = true;
          L.runsThisPlay++;
          this.addRun(1);
          this.emit('splash', { text: 'RUN!', sub: `${LINEUP[r.li].name} 득점` });
          this.checkWalkOffLive();
          if (this.phase !== 'LIVE') return; // 끝내기로 플레이 종료됨
        } else {
          r.state = 'onbase'; r.from = r.to; r.prog = 0;
        }
      }
    }
    // onbase 정규화
    for (const r of L.runners) {
      if (r.state === 'onbase') { r.from = r.to; r.prog = 0; }
    }
  }

  checkOuts() {
    const L = this.live, b = L.ball;
    if (b.holder < 0) return;
    const holder = L.fielders[b.holder];
    for (const r of L.runners) {
      if (r.out || r.scored) continue;
      if (r.state === 'onbase') continue;
      const pos = this.runnerXY(r);
      // 포스 아웃: 홀더가 목표 베이스를 밟고 있고 주자가 포스 상태
      if (r.state === 'run') {
        const tb = this.baseXY(r.to);
        const forced = r.isBatter ? r.to === 1 : this.isForcedLive(r);
        if (forced && dist2(holder.x, holder.y, tb.x, tb.y) < 2.5 && r.prog < 0.99) {
          this.runnerOut(r, '포스 아웃');
          if (this.phase !== 'LIVE') return; // 3아웃으로 플레이 종료됨
          continue;
        }
      }
      // 태그 아웃
      if (dist2(holder.x, holder.y, pos.x, pos.y) < 3 && r.prog > 0.03 && r.prog < 0.97) {
        this.runnerOut(r, '태그 아웃');
        if (this.phase !== 'LIVE') return;
      }
    }
  }

  isForcedLive(r) {
    // 타자주자는 1루까지 항상 포스. 다른 주자는 인플레이 시작 시 포스 상태였고
    // 타자가 아직 아웃되지 않았을 때만 포스 유지 (타자 아웃 시 포스 해제)
    const L = this.live;
    if (r.isBatter) return r.to === 1;
    return !!r.forced && !L.batterOut && !L.caughtFly;
  }

  runnerOut(r, label) {
    const L = this.live;
    r.out = true;
    L.outsThisPlay++;
    this.emit('splash', { text: 'OUT!', sub: `${LINEUP[r.li].name} ${label}` });
    this.emit('sound', { kind: 'out' });
    if (r.isBatter) L.batterOut = true;
    L.settleTimer = 0;
    this.checkThreeOuts();
  }

  checkThreeOuts() {
    if (this.outs + this.live.outsThisPlay >= 3) this.finishPlay();
  }

  checkWalkOffLive() {
    // 9회말 이후 홈 리드 → 끝내기 (플레이 즉시 종료)
    if (this.half === 1 && this.inning >= RULES.innings &&
        this.totalRuns('home') > this.totalRuns('away')) {
      this.finishPlay(true);
    }
  }

  checkSettle(dtMs) {
    const L = this.live;
    if (this.phase !== 'LIVE') return;
    const allSettled = L.runners.every(r => r.out || r.scored || r.state === 'onbase');
    if (L.ball.holder >= 0 && allSettled) {
      L.settleTimer += dtMs;
      if (L.settleTimer >= 800) this.finishPlay();
    } else {
      L.settleTimer = 0;
    }
    if (L.playTimer > RULES.playTimeoutMs) {
      for (const r of L.runners) {
        if (!r.out && !r.scored && r.state !== 'onbase') {
          r.state = 'onbase';
          r.from = r.to = r.prog >= 0.5 ? r.to : r.from; r.prog = 0;
        }
      }
      this.finishPlay();
    }
  }

  finishPlay(walkOff = false) {
    if (this.phase !== 'LIVE') return;
    const L = this.live;
    const side = this.battingSide();
    this.outs += L.outsThisPlay;
    // 타자 결과 → 안타 기록
    const br = L.runners.find(r => r.isBatter);
    let summary;
    if (L.ball.hr) {
      summary = this.lastPlaySummary;
    } else if (br && br.out) {
      summary = L.caughtFly ? `${this.batter().name} 플라이 아웃` : `${this.batter().name} 땅볼 아웃`;
      if (L.caughtFly && L.runsThisPlay > 0 && this.outs < 3) {
        summary = `${this.batter().name} 희생플라이!`;
        this.emit('splash', { text: 'SAC FLY!', sub: `${L.runsThisPlay}점 득점` });
      }
    } else if (br && br.scored) {
      summary = `${this.batter().name} 인사이드파크 홈런!`;
      if (!L.errorThisPlay) this.hits[side]++;
    } else if (br) {
      const base = br.state === 'onbase' ? br.from : br.to;
      const names = { 1: '안타', 2: '2루타', 3: '3루타' };
      if (!L.errorThisPlay) {
        this.hits[side]++;
        summary = `${this.batter().name} ${names[base] || '안타'}!`;
        if (base >= 2) this.emit('splash', { text: base === 3 ? 'TRIPLE!' : 'DOUBLE!', sub: summary });
      } else {
        summary = `${this.batter().name} 에러로 출루`;
      }
    } else {
      summary = '플레이 종료';
    }
    if (L.outsThisPlay >= 2) {
      this.emit('splash', { text: L.outsThisPlay >= 3 ? 'TRIPLE PLAY!' : 'DOUBLE PLAY!', sub: '병살!' });
    }
    this.lastPlaySummary = summary;
    // 남은 주자 → 베이스 점유 반영
    this.bases = [null, null, null, null];
    for (const r of L.runners) {
      if (r.out || r.scored) continue;
      let b = r.state === 'onbase' ? r.from : (r.prog >= 0.5 ? r.to : r.from);
      while (b >= 1 && b <= 3 && this.bases[b] !== null) b--; // 중복 점유 방지
      if (b >= 1 && b <= 3) this.bases[b] = r.li;
    }
    this.emit('playResult', {
      summary, outs: Math.min(this.outs, 3),
      runs: L.runsThisPlay, state: this.getFullState(),
    });
    this.live = null;
    this.batterIdx[side]++;
    this.balls = 0; this.strikes = 0;
    this.currentPitch = null;
    if (walkOff) { this.gameOver('home'); return; }
    if (this.outs >= 3) this.endHalfInning();
    else {
      this.checkWalkOff();
      if (this.phase !== 'GAME_OVER') {
        this.phase = 'PITCHING';
        this.emit('state', { state: this.getFullState() });
      }
    }
  }

  checkWalkOff() {
    if (this.half === 1 && this.inning >= RULES.innings &&
        this.totalRuns('home') > this.totalRuns('away')) {
      this.gameOver('home');
    }
  }

  // ---------- 이닝/경기 종료 ----------
  endHalfInning() {
    const side = this.battingSide();
    const arr = this.score[side];
    while (arr.length < this.inning) arr.push(0); // 0점 이닝 기록
    this.outs = 0; this.balls = 0; this.strikes = 0;
    this.bases = [null, null, null, null];
    this.live = null;
    const away = this.totalRuns('away'), home = this.totalRuns('home');

    if (this.half === 0) {
      // 초 종료 → 9회 이후 홈이 이기고 있으면 말 공격 불필요
      if (this.inning >= RULES.innings && home > away) { this.gameOver('home'); return; }
      this.half = 1;
    } else {
      // 말 종료
      if (this.inning >= RULES.innings) {
        if (home !== away) { this.gameOver(home > away ? 'home' : 'away'); return; }
        if (this.inning >= RULES.maxInnings) { this.gameOver(null); return; } // 무승부
      }
      this.half = 0;
      this.inning++;
    }
    this.phase = 'MID_INNING';
    this.midTimer = RULES.midInningMs;
    this.emit('midInning', { state: this.getFullState() });
  }

  gameOver(winner) {
    this.winner = winner;
    this.phase = 'GAME_OVER';
    this.emit('gameOver', {
      winner,
      state: this.getFullState(),
    });
    this.emit('sound', { kind: 'cheer' });
  }

  // ---------- 스냅샷 ----------
  emitSnap() {
    this.emit('snap', this.getSnapshot());
  }

  getSnapshot() {
    const L = this.live;
    if (!L) return null;
    return {
      ball: { x: +L.ball.x.toFixed(1), y: +L.ball.y.toFixed(1), z: +L.ball.z.toFixed(1), mode: L.ball.mode, hr: L.ball.hr },
      holder: L.ball.holder,
      ctrl: L.ctrl,
      fielders: L.fielders.map(f => [+f.x.toFixed(1), +f.y.toFixed(1)]),
      runners: L.runners.filter(r => !r.out && !r.scored).map(r => {
        const p = this.runnerXY(r);
        return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), li: r.li, isBatter: r.isBatter, state: r.state };
      }),
      outs: Math.min(3, this.outs + L.outsThisPlay),
    };
  }
}

module.exports = { GameEngine };
