// net.js — клиент мультиплеера: WebSocket, профиль, друзья, комнаты, снимки состояния
import { S, persist } from './store.js';

// адрес сервера по умолчанию (можно поменять в Настройках). Впишите сюда свой после развёртывания на Render.
export const DEFAULT_SERVER = '';

export const net = {
  ws: null,
  ready: false, // получили welcome
  handlers: {},
  friends: { friends: [], inc: [], out: [] },
  room: null,
  snaps: [], // буфер снимков для интерполяции
  offset: 0, // разница часов: серверного времени нет, используем локальное время получения
  ping: 0,
  last: null,
};

export const on = (t, fn) => { net.handlers[t] = fn; };
const emit = (t, m) => { const h = net.handlers[t]; if (h) h(m); };

export function serverUrl() {
  let s = (S.server || DEFAULT_SERVER || '').trim();
  if (!s) return '';
  if (!/^wss?:\/\//.test(s)) s = (/^(localhost|127\.|192\.168\.|10\.)/.test(s) ? 'ws://' : 'wss://') + s;
  return s;
}

let timer = null;
let keep = null;
export function connect() {
  return new Promise((resolve) => {
    const url = serverUrl();
    if (!url) { resolve({ ok: false, reason: 'noserver' }); return; }
    if (net.ws && net.ws.readyState === 1 && net.ready) { resolve({ ok: true }); return; }
    disconnect();
    let ws;
    try { ws = new WebSocket(url); } catch { resolve({ ok: false, reason: 'bad' }); return; }
    net.ws = ws;
    let done = false;
    const fin = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    timer = setTimeout(() => { fin({ ok: false, reason: 'timeout' }); try { ws.close(); } catch { /* */ } }, 12000);
    ws.onopen = () => send({ t: 'hello', name: S.name, pid: S.pid, token: S.token, car: S.car });
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 's') {
        m.at = performance.now();
        net.snaps.push(m);
        if (net.snaps.length > 12) net.snaps.shift();
        return;
      }
      if (m.t === 'welcome') {
        S.pid = m.pid; S.token = m.token; S.name = m.name;
        persist();
        net.ready = true;
        fin({ ok: true });
      } else if (m.t === 'friends') net.friends = m;
      else if (m.t === 'room') net.room = m;
      else if (m.t === 'left') net.room = null;
      emit(m.t, m);
    };
    ws.onclose = () => {
      net.ready = false;
      clearInterval(keep);
      fin({ ok: false, reason: 'closed' });
      emit('closed', {});
    };
    ws.onerror = () => {};
    clearInterval(keep);
    keep = setInterval(() => send({ t: 'ping' }), 15000);
  });
}
export function disconnect() {
  clearTimeout(timer);
  clearInterval(keep);
  if (net.ws) { net.ws.onclose = null; try { net.ws.close(); } catch { /* */ } }
  net.ws = null;
  net.ready = false;
  net.room = null;
  net.snaps = [];
}
export function send(o) {
  if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(o));
}
export const online = () => !!(net.ws && net.ws.readyState === 1 && net.ready);

// ---- интерполяция: рисуем состояние на 100 мс в прошлом
const DELAY = 100;
export function sample() {
  const sn = net.snaps;
  if (!sn.length) return null;
  const t = performance.now() - DELAY;
  let a = sn[0];
  let b = sn[0];
  for (let i = 0; i < sn.length; i++) {
    if (sn[i].at <= t) a = sn[i];
    if (sn[i].at > t) { b = sn[i]; break; }
    b = sn[i];
  }
  const k = a === b ? 0 : Math.max(0, Math.min(1, (t - a.at) / (b.at - a.at)));
  return { a, b, k, latest: sn[sn.length - 1] };
}
