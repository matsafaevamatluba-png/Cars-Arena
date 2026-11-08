// server.js — сервер мультиплеера «Arena Cars». Без зависимостей: только Node.js 18+.
// Запуск: node server/server.js   (порт берётся из переменной PORT, по умолчанию 8080)
// Сервер сам считает игру (та же физика src/sim.js), клиенты шлют только управление и получают снимки состояния.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld, stepWorld, ABILITIES } from '../src/sim.js';
import { CARS } from '../src/cars.js';

const PORT = Number(process.env.PORT) || 8080;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(HERE, 'data.json');
const MAX_PLAYERS = 4;
const ARENAS = 4;
const DT = 1 / 60;
const SEND_EVERY = 2; // снимок каждые 2 шага = 30 раз в секунду

// ------------------------------------------------------------ профили и друзья
let db = { players: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); if (!db.players) db.players = {}; } catch { /* первый запуск */ }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.warn('не удалось сохранить', e.message); }
  }, 1500);
}
const rid14 = () => {
  for (;;) {
    let s = String(1 + Math.floor(Math.random() * 9));
    for (let i = 0; i < 13; i++) s += Math.floor(Math.random() * 10);
    if (!db.players[s]) return s;
  }
};
const cleanName = (n) => String(n || '').replace(/[<>&"'`\\]/g, '').trim().slice(0, 14) || 'Игрок';

// ------------------------------------------------------------ WebSocket (RFC 6455)
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsSend(sock, str) {
  if (sock.destroyed || !sock.writable) return;
  const body = Buffer.from(str);
  const n = body.length;
  let head;
  if (n < 126) head = Buffer.from([0x81, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  sock.write(Buffer.concat([head, body]));
}
function wsClose(sock) { try { sock.end(Buffer.from([0x88, 0])); } catch { /* уже закрыт */ } }

function attachWs(sock, onMessage, onClose) {
  let buf = Buffer.alloc(0);
  let frag = null;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > 1 << 16) { sock.destroy(); return; }
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16384) { sock.destroy(); return; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.subarray(need);
      if (op === 0x8) { wsClose(sock); sock.destroy(); return; }
      if (op === 0x9) { // ping -> pong
        const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
        if (payload.length < 126) sock.write(pong);
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x0) {
        frag = op === 0x1 ? payload : Buffer.concat([frag || Buffer.alloc(0), payload]);
        if (fin) { const s = frag.toString('utf8'); frag = null; onMessage(s); }
      }
    }
  });
  sock.on('close', onClose);
  sock.on('error', () => {});
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' });
  res.end(req.url === '/health' ? 'ok' : 'Arena Cars server работает. Игроков онлайн: ' + clients.size);
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const cl = { sock, pid: null, room: null, car: 0, alive: true, lastMsg: Date.now() };
  attachWs(sock, (s) => { cl.lastMsg = Date.now(); handle(cl, s); }, () => drop(cl));
});

// ------------------------------------------------------------ клиенты
const clients = new Set(); // авторизованные
const byPid = new Map();
const send = (cl, obj) => { if (cl && cl.alive) wsSend(cl.sock, JSON.stringify(obj)); };
const online = (pid) => byPid.has(pid);

function profileView(pid) { const p = db.players[pid]; return p ? { pid, name: p.name, online: online(pid) } : null; }
function sendFriends(cl) {
  const p = db.players[cl.pid];
  if (!p) return;
  send(cl, {
    t: 'friends',
    friends: p.friends.map(profileView).filter(Boolean),
    inc: p.inc.map(profileView).filter(Boolean),
    out: p.out.map(profileView).filter(Boolean),
  });
}
const pushFriends = (pid) => { const c = byPid.get(pid); if (c) sendFriends(c); };

function drop(cl) {
  if (!cl.alive) return;
  cl.alive = false;
  clients.delete(cl);
  if (cl.pid && byPid.get(cl.pid) === cl) {
    byPid.delete(cl.pid);
    for (const f of db.players[cl.pid].friends) pushFriends(f);
  }
  leaveRoom(cl);
  queue = queue.filter((c) => c !== cl);
}

// ------------------------------------------------------------ комнаты
const rooms = new Map();
let queue = []; // быстрый поиск
const BOT_NAMES = ['Турбо', 'Нитро', 'Дрифтер', 'Молния', 'Бульдозер', 'Комета', 'Гонщик', 'Ураган', 'Фантом', 'Вираж'];
const carOf = (i) => CARS[Math.max(0, Math.min(CARS.length - 1, i | 0))];

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = '';
    for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(s)) return s;
  }
}
function makeRoom(host, quick) {
  const r = { code: newCode(), host, members: [], arena: Math.floor(Math.random() * ARENAS), quick: !!quick, state: 'lobby', world: null, tick: 0, evBuf: [], over: 0, bornAt: Date.now() };
  rooms.set(r.code, r);
  return r;
}
function roomInfo(r) {
  return {
    t: 'room', code: r.code, arena: r.arena, quick: r.quick, state: r.state,
    players: r.members.map((m) => ({ pid: m.pid, name: db.players[m.pid].name, car: m.car, host: m === r.host })),
  };
}
const broadcastRoom = (r) => { const i = roomInfo(r); for (const m of r.members) send(m, i); };
function joinRoom(cl, r) {
  if (r.state !== 'lobby') return send(cl, { t: 'err', m: 'Матч уже идёт' });
  if (r.members.length >= MAX_PLAYERS) return send(cl, { t: 'err', m: 'Комната заполнена' });
  leaveRoom(cl);
  queue = queue.filter((c) => c !== cl);
  r.members.push(cl);
  cl.room = r;
  broadcastRoom(r);
}
function leaveRoom(cl) {
  const r = cl.room;
  if (!r) return;
  cl.room = null;
  r.members = r.members.filter((m) => m !== cl);
  if (r.world && r.state === 'play') {
    const c = r.world.cars.find((x) => x.pid === cl.pid);
    if (c) { c.pid = null; c.isPlayer = false; c.bot = { t: 0, use: 0, hold: 0 }; }
  }
  if (!r.members.length) { rooms.delete(r.code); return; }
  if (r.host === cl) r.host = r.members[0];
  if (r.state === 'lobby') broadcastRoom(r);
}

function startRoom(r) {
  if (r.state !== 'lobby') return;
  const entries = r.members.map((m) => ({ name: db.players[m.pid].name, def: carOf(m.car), isPlayer: false, pid: m.pid }));
  const used = new Set();
  while (entries.length < MAX_PLAYERS) {
    let nm;
    do { nm = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; } while (used.has(nm));
    used.add(nm);
    entries.push({ name: nm + ' (бот)', def: carOf(Math.floor(Math.random() * Math.min(CARS.length, 12))), isPlayer: false });
  }
  const w = createWorld(entries);
  w.cars.forEach((c, i) => {
    c.pid = entries[i].pid || null;
    if (c.pid) { c.bot = null; } // управляет человек
  });
  w.playerId = -1;
  r.world = w;
  r.state = 'play';
  r.tick = 0;
  r.evBuf = [];
  r.over = 0;
  for (const m of r.members) {
    const id = w.cars.findIndex((c) => c.pid === m.pid);
    send(m, {
      t: 'start', you: id, arena: r.arena, code: r.code,
      cars: w.cars.map((c) => ({ id: c.id, name: c.name, car: c.def.id, bot: !c.pid })),
      pads: w.pads.map((p) => [Number(p.a.toFixed(4)), p.r0]),
    });
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
function snapshot(r) {
  const w = r.world;
  const st = w.state === 'countdown' ? 0 : w.state === 'play' ? 1 : 2;
  const s = {
    t: 's', st, cd: r2(w.countdown), pt: r2(w.playT), rf: r2(w.rFlat), rt: r2(w.rTop), ly: r2(w.lavaY), sk: w.shrinking ? 1 : 0,
    win: w.winner ? w.winner.id : -1,
    c: w.cars.map((c) => [
      r2(c.x), r2(c.z), r2(c.h), r2(c.y), r2(c.jy), Math.round(c.hp),
      (c.alive ? 1 : 0) | (c.falling ? 2 : 0) | (c.shield ? 4 : 0) | (c.wrecked ? 8 : 0),
      c.ability ? ABILITIES.indexOf(c.ability) : -1, r2(c.jumpCd), r2(c.vx), r2(c.vz), c.place | 0,
    ]),
    p: w.pads.map((p) => (p.off ? -2 : p.type ? ABILITIES.indexOf(p.type) : -1)),
    sh: w.shots.map((x) => [x.k === 'missile' ? 0 : 1, r2(x.x), r2(x.z), r2(x.h), x.owner]),
    ev: r.evBuf,
  };
  r.evBuf = [];
  return JSON.stringify(s);
}

function stepRoom(r) {
  const w = r.world;
  stepWorld(w, DT);
  if (w.events.length) { for (const e of w.events) r.evBuf.push(e); w.events.length = 0; }
  r.tick++;
  if (r.tick % SEND_EVERY === 0) {
    const s = snapshot(r);
    for (const m of r.members) if (m.alive) wsSend(m.sock, s);
  }
  if (w.state === 'ended') {
    r.over += DT;
    if (r.over > 6) { // назад в комнату
      r.state = 'lobby';
      r.world = null;
      broadcastRoom(r);
    }
  }
}

// ------------------------------------------------------------ сообщения
function handle(cl, str) {
  let m;
  try { m = JSON.parse(str); } catch { return; }
  if (!m || typeof m.t !== 'string') return;
  if (m.t === 'hello') {
    let p = m.pid && db.players[m.pid];
    if (!(p && p.token === m.token)) {
      const pid = rid14();
      p = { name: cleanName(m.name), token: crypto.randomBytes(12).toString('hex'), friends: [], inc: [], out: [] };
      db.players[pid] = p;
      m.pid = pid;
    }
    if (m.name) p.name = cleanName(m.name);
    const old = byPid.get(m.pid);
    if (old && old !== cl) { send(old, { t: 'err', m: 'Вход с другого устройства' }); drop(old); wsClose(old.sock); }
    cl.pid = m.pid;
    cl.car = carOf(m.car).id;
    clients.add(cl);
    byPid.set(cl.pid, cl);
    save();
    send(cl, { t: 'welcome', pid: cl.pid, token: p.token, name: p.name });
    sendFriends(cl);
    for (const f of p.friends) pushFriends(f);
    return;
  }
  if (!cl.pid) return;
  const me = db.players[cl.pid];
  switch (m.t) {
    case 'in': {
      const r = cl.room;
      if (!r || !r.world) return;
      const c = r.world.cars.find((x) => x.pid === cl.pid);
      if (!c) return;
      const sx = Number(m.sx) || 0;
      const sz = Number(m.sz) || 0;
      const l = Math.hypot(sx, sz);
      c.input.sx = l > 1 ? sx / l : sx;
      c.input.sz = l > 1 ? sz / l : sz;
      if (m.use) c.input.use = true;
      if (m.jump) c.input.jump = true;
      return;
    }
    case 'name': me.name = cleanName(m.name); save(); send(cl, { t: 'welcome', pid: cl.pid, token: me.token, name: me.name }); if (cl.room && cl.room.state === 'lobby') broadcastRoom(cl.room); return;
    case 'car': cl.car = carOf(m.car).id; if (cl.room && cl.room.state === 'lobby') broadcastRoom(cl.room); return;
    case 'quick': {
      leaveRoom(cl);
      cl.car = carOf(m.car).id;
      cl.qs = Date.now();
      if (!queue.includes(cl)) queue.push(cl);
      send(cl, { t: 'queue', n: queue.length });
      return;
    }
    case 'unqueue': queue = queue.filter((c) => c !== cl); return;
    case 'create': { leaveRoom(cl); cl.car = carOf(m.car).id; const r = makeRoom(cl, false); joinRoom(cl, r); return; }
    case 'join': {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) return send(cl, { t: 'err', m: 'Комната не найдена' });
      cl.car = carOf(m.car).id;
      joinRoom(cl, r);
      return;
    }
    case 'arena': { const r = cl.room; if (r && r.host === cl && r.state === 'lobby') { r.arena = ((m.i | 0) % ARENAS + ARENAS) % ARENAS; broadcastRoom(r); } return; }
    case 'start': { const r = cl.room; if (r && r.host === cl) startRoom(r); return; }
    case 'leave': leaveRoom(cl); queue = queue.filter((c) => c !== cl); send(cl, { t: 'left' }); return;
    // ---- друзья
    case 'flist': return sendFriends(cl);
    case 'fsearch': {
      const pid = String(m.pid || '').replace(/\D/g, '');
      const o = db.players[pid];
      if (!o) return send(cl, { t: 'fsearch', found: false });
      const st = pid === cl.pid ? 'self' : me.friends.includes(pid) ? 'friend' : me.out.includes(pid) ? 'sent' : me.inc.includes(pid) ? 'incoming' : 'none';
      return send(cl, { t: 'fsearch', found: true, pid, name: o.name, status: st, online: online(pid) });
    }
    case 'freq': {
      const pid = String(m.pid || '');
      const o = db.players[pid];
      if (!o || pid === cl.pid || me.friends.includes(pid)) return;
      if (me.inc.includes(pid)) return acceptFriend(cl.pid, pid);
      if (!me.out.includes(pid)) me.out.push(pid);
      if (!o.inc.includes(cl.pid)) o.inc.push(cl.pid);
      save();
      sendFriends(cl);
      pushFriends(pid);
      return send(cl, { t: 'info', m: 'Запрос отправлен' });
    }
    case 'fans': {
      const pid = String(m.pid || '');
      const o = db.players[pid];
      if (!o || !me.inc.includes(pid)) return;
      if (m.ok) return acceptFriend(cl.pid, pid);
      me.inc = me.inc.filter((x) => x !== pid); // отклонил: убираем у обоих, чтобы можно было отправить запрос снова
      o.out = o.out.filter((x) => x !== cl.pid);
      save();
      sendFriends(cl);
      pushFriends(pid);
      return;
    }
    case 'fremove': {
      const pid = String(m.pid || '');
      const o = db.players[pid];
      me.friends = me.friends.filter((x) => x !== pid);
      if (o) o.friends = o.friends.filter((x) => x !== cl.pid);
      save();
      sendFriends(cl);
      pushFriends(pid);
      return;
    }
    case 'invite': {
      const t = byPid.get(String(m.pid || ''));
      if (t && cl.room && me.friends.includes(t.pid)) send(t, { t: 'invite', code: cl.room.code, from: me.name });
      return;
    }
  }
}
function acceptFriend(a, b) {
  const A = db.players[a];
  const B = db.players[b];
  for (const [X, y] of [[A, b], [B, a]]) {
    X.inc = X.inc.filter((p) => p !== y);
    X.out = X.out.filter((p) => p !== y);
    if (!X.friends.includes(y)) X.friends.push(y);
  }
  save();
  pushFriends(a);
  pushFriends(b);
}

// ------------------------------------------------------------ главный цикл
let last = process.hrtime.bigint();
let acc = 0;
setInterval(() => {
  const now = process.hrtime.bigint();
  acc += Math.min(0.25, Number(now - last) / 1e9);
  last = now;
  // быстрый поиск: 4 игрока сразу или 2+ после 5 секунд ожидания
  if (queue.length) {
    queue = queue.filter((c) => c.alive);
    if (queue.length >= 4 || Date.now() - Math.min(...queue.map((c) => c.qs)) > 5000) {
      const grp = queue.splice(0, 4);
      const r = makeRoom(grp[0], true);
      for (const c of grp) joinRoom(c, r);
      startRoom(r);
    }
  }
  while (acc >= DT) {
    acc -= DT;
    for (const r of rooms.values()) if (r.state === 'play' && r.world) stepRoom(r);
  }
}, 8);
// пинг неактивных клиентов (чтобы прокси не рвал соединение) и уборка мёртвых
setInterval(() => {
  const t = Date.now();
  for (const c of [...clients]) {
    if (t - c.lastMsg > 45000) { drop(c); c.sock.destroy(); }
  }
}, 10000);

server.listen(PORT, () => console.log('Arena Cars сервер: порт ' + PORT));
