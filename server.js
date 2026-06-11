'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { GameEngine } = require('./game/engine');
const { FIELD, POSITIONS, LINEUP, PITCHERS, PITCH_KINDS, ZONE_EDGE, RULES } = require('./game/constants');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 4096 });

// 클라이언트는 이 config만으로 렌더링 (서버/클라 상수 중복 방지)
const CLIENT_CONFIG = {
  lineup: LINEUP, pitchers: PITCHERS, positions: POSITIONS,
  field: { bases: FIELD.bases, mound: FIELD.mound, fenceHeight: FIELD.fenceHeight, fence: { c: 400, drop: 70, exp: 1.2 }, foulDeg: FIELD.foulDeg },
  pitchKinds: PITCH_KINDS, zoneEdge: ZONE_EDGE, rules: { swingGraceMs: RULES.swingGraceMs, windupMs: RULES.windupMs },
};

const rooms = new Map(); // code -> room

function makeCode() {
  for (let i = 0; i < 100; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const side of ['home', 'away']) {
    const p = room.players[side];
    if (p && p.ws && p.ws.readyState === 1) p.ws.send(msg);
  }
}

function makeRoom(code) {
  const room = {
    code,
    players: { home: null, away: null }, // {ws, token, connected}
    pending: [], // 시작 전 입장자 [{ws, token}]
    engine: null,
    paused: false,
    rejoinTimer: null,
    interval: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function destroyRoom(room) {
  if (room.interval) clearInterval(room.interval);
  if (room.rejoinTimer) clearTimeout(room.rejoinTimer);
  rooms.delete(room.code);
}

function startGame(room) {
  // 선공/후공 랜덤 배정 (away = 선공)
  const [a, b] = Math.random() < 0.5 ? [0, 1] : [1, 0];
  room.players.home = room.pending[a];
  room.players.away = room.pending[b];
  room.pending = [];
  room.players.home.ws._side = 'home';
  room.players.away.ws._side = 'away';
  room.engine = new GameEngine();
  room.engine.startGame();
  room.engine.drainEvents();
  for (const side of ['home', 'away']) {
    send(room.players[side].ws, {
      t: 'start', you: side, config: CLIENT_CONFIG, state: room.engine.getFullState(),
    });
  }
  room.interval = setInterval(() => tickRoom(room), RULES.tickMs);
}

function tickRoom(room) {
  if (room.paused || !room.engine) return;
  room.engine.update(RULES.tickMs);
  flushEvents(room);
}

function flushEvents(room) {
  if (!room.engine) return;
  for (const ev of room.engine.drainEvents()) broadcast(room, ev);
}

function handleLeave(ws) {
  const room = ws._room;
  if (!room || !rooms.has(room.code)) return;
  // 시작 전이면 대기열에서 제거, 아무도 없으면 방 삭제
  const pi = room.pending.findIndex(p => p.ws === ws);
  if (pi >= 0) {
    room.pending.splice(pi, 1);
    if (room.pending.length === 0) destroyRoom(room);
    else broadcast(room, { t: 'info', msg: '상대가 나갔습니다' });
    return;
  }
  const side = ws._side;
  if (!side || !room.players[side] || room.players[side].ws !== ws) return;
  room.players[side].connected = false;
  room.players[side].ws = null;
  const other = room.players[side === 'home' ? 'away' : 'home'];
  if (!other || !other.connected) { destroyRoom(room); return; } // 둘 다 이탈
  if (room.engine && room.engine.phase === 'GAME_OVER') return;
  room.paused = true;
  send(other.ws, { t: 'oppLeft', deadlineMs: RULES.rejoinGraceMs });
  room.rejoinTimer = setTimeout(() => {
    // 30초 내 미복귀 → 몰수
    const winner = side === 'home' ? 'away' : 'home';
    if (room.engine) { room.engine.winner = winner; room.engine.phase = 'GAME_OVER'; }
    send(other.ws, { t: 'gameOver', winner, forfeit: true, state: room.engine ? room.engine.getFullState() : null });
  }, RULES.rejoinGraceMs);
}

wss.on('connection', (ws) => {
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') { send(ws, { t: 'pong', ts: m.ts }); return; }

    if (m.t === 'create') {
      if (ws._room) return;
      const code = makeCode();
      if (!code) { send(ws, { t: 'error', msg: '방 생성 실패' }); return; }
      const room = makeRoom(code);
      const token = crypto.randomUUID();
      room.pending.push({ ws, token, connected: true });
      ws._room = room;
      send(ws, { t: 'created', code, token });
      return;
    }

    if (m.t === 'join') {
      if (ws._room) return;
      const room = rooms.get(String(m.code || ''));
      if (!room) { send(ws, { t: 'error', msg: '방을 찾을 수 없습니다' }); return; }
      if (room.engine || room.pending.length >= 2) { send(ws, { t: 'error', msg: '이미 시작된 방입니다' }); return; }
      const token = crypto.randomUUID();
      room.pending.push({ ws, token, connected: true });
      ws._room = room;
      send(ws, { t: 'joined', code: room.code, token });
      startGame(room);
      return;
    }

    if (m.t === 'rejoin') {
      if (ws._room) return;
      const room = rooms.get(String(m.code || ''));
      if (!room || !room.engine) { send(ws, { t: 'error', msg: '진행 중인 방이 없습니다' }); return; }
      const side = ['home', 'away'].find(s => room.players[s] && room.players[s].token === m.token && !room.players[s].connected);
      if (!side) { send(ws, { t: 'error', msg: '재접속 정보가 올바르지 않습니다' }); return; }
      room.players[side].ws = ws;
      room.players[side].connected = true;
      ws._room = room; ws._side = side;
      if (room.rejoinTimer) { clearTimeout(room.rejoinTimer); room.rejoinTimer = null; }
      room.paused = false;
      send(ws, { t: 'start', you: side, config: CLIENT_CONFIG, state: room.engine.getFullState(), resumed: true });
      const other = room.players[side === 'home' ? 'away' : 'home'];
      if (other && other.ws) send(other.ws, { t: 'oppBack' });
      return;
    }

    // ---- 이하 게임 입력: 방/사이드 필요 ----
    const room = ws._room;
    const side = ws._side;
    if (!room || !side || !room.engine || room.paused) return;
    const eng = room.engine;

    switch (m.t) {
      case 'pitch': eng.handlePitch(side, { kind: m.kind, aim: m.aim || {}, power: m.power }); break;
      case 'swing': eng.handleSwing(side, { aim: m.aim || {}, dt: m.dt, bunt: m.bunt }); break;
      case 'swap': eng.handleSwap(side); break;
      case 'move': eng.handleMove(side, m.dir || {}); break;
      case 'throw': eng.handleThrow(side, m.base); break;
      case 'run': eng.handleRun(side, m.cmd); break;
      case 'newGame': {
        if (eng.phase !== 'GAME_OVER') break;
        const both = room.players.home && room.players.away && room.players.home.connected && room.players.away.connected;
        if (!both) break;
        room.engine = new GameEngine();
        room.engine.startGame();
        room.engine.drainEvents();
        for (const s of ['home', 'away']) {
          send(room.players[s].ws, { t: 'start', you: s, config: CLIENT_CONFIG, state: room.engine.getFullState() });
        }
        break;
      }
    }
    flushEvents(room);
  });

  ws.on('close', () => handleLeave(ws));
  ws.on('error', () => { try { ws.close(); } catch {} });
});

// 죽은 연결 감지
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) { ws.terminate(); continue; }
    ws._alive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

// 오래된 빈 방 청소
setInterval(() => {
  for (const room of rooms.values()) {
    const empty = !room.players.home?.connected && !room.players.away?.connected && room.pending.length === 0;
    if (empty || (Date.now() - room.createdAt > 6 * 3600 * 1000)) destroyRoom(room);
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`DUGOUT DUEL listening on :${PORT}`);
});
