// audio.js — весь звук игры синтезируется в WebAudio (файлов не нужно):
// музыка лобби (7 треков по порядку), шум толпы с криками и аплодисментами, удары, взрывы, лава, двигатель.
// Свои песни: положите файлы public/music/1.mp3 … 7.mp3 — они заменят синтезированные треки с тем же номером.

import { S } from './store.js';

let ctx = null;
let master = null;
let musBus = null;
let sfxBus = null;
let crowdBus = null;
let noiseBuf = null;
let applauseBuf = null;
const rnd = (a, b) => a + Math.random() * (b - a);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function initAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    return false;
  }
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 5;
  master = ctx.createGain();
  master.connect(comp);
  comp.connect(ctx.destination);
  musBus = ctx.createGain();
  sfxBus = ctx.createGain();
  crowdBus = ctx.createGain();
  musBus.connect(master);
  sfxBus.connect(master);
  crowdBus.connect(master);
  // три секунды шума — основа для взрывов, ветра, толпы
  const n = ctx.sampleRate * 3;
  noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  // аплодисменты: плотная россыпь коротких хлопков
  applauseBuf = ctx.createBuffer(2, ctx.sampleRate * 3, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const a = applauseBuf.getChannelData(ch);
    for (let i = 0; i < a.length; i++) {
      if (Math.random() < 1100 / ctx.sampleRate) {
        const amp = rnd(0.3, 1);
        const len = 70 + ((Math.random() * 60) | 0);
        for (let k = 0; k < len && i + k < a.length; k++) a[i + k] += (Math.random() * 2 - 1) * amp * Math.exp(-k / 20);
      }
    }
  }
  setVolumes();
  probeMusicFiles();
  return true;
}

export function setVolumes() {
  if (!ctx) return;
  master.gain.value = S.vol;
  musBus.gain.value = S.mus * 0.9;
  sfxBus.gain.value = 1;
  crowdBus.gain.value = 0.9;
}
export const audioReady = () => !!ctx;

// ---------------------------------------------------------------- кирпичики
function tone(dest, t, dur, o) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.f0, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol || 0.3, t + (o.a || 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}
function noise(dest, t, dur, o) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = o.ftype || 'lowpass';
  f.frequency.setValueAtTime(o.f0, t);
  if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + dur);
  f.Q.value = o.q || 0.7;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol || 0.3, t + (o.a || 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t, Math.random() * 1.5);
  src.stop(t + dur + 0.03);
}

// пространственный выход: громкость падает с расстоянием, звук смещается влево/вправо
function out(sp) {
  const g = ctx.createGain();
  g.gain.value = sp ? sp.v : 1;
  let last = g;
  if (sp && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, sp.pan));
    g.connect(p);
    last = p;
  }
  last.connect(sfxBus);
  return g;
}
const now = () => ctx.currentTime;

// ---------------------------------------------------------------- эффекты
export const sfx = {
  click() { if (!ctx) return; const t = now(); tone(sfxBus, t, 0.08, { type: 'triangle', f0: 900, f1: 600, vol: 0.18 }); },
  tick() { if (!ctx) return; tone(sfxBus, now(), 0.12, { type: 'square', f0: 620, vol: 0.14 }); },
  go() { if (!ctx) return; const t = now(); tone(sfxBus, t, 0.5, { type: 'square', f0: 880, vol: 0.16 }); tone(sfxBus, t, 0.5, { type: 'sawtooth', f0: 1320, vol: 0.08 }); },
  // столкновение машин: глухой удар + металлический лязг, сильнее — громче и «хрустит»
  bump(sp, p = 0.5) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    tone(o, t, 0.2, { type: 'sine', f0: 170, f1: 48, vol: 0.5 * (0.5 + p) });
    noise(o, t, 0.1, { ftype: 'highpass', f0: 2500, vol: 0.25 * (0.4 + p) });
    tone(o, t, 0.25, { type: 'square', f0: 640 + rnd(-60, 60), f1: 560, vol: 0.06 * p });
    tone(o, t + 0.01, 0.18, { type: 'square', f0: 930 + rnd(-80, 80), f1: 700, vol: 0.05 * p });
    if (p > 0.55) noise(o, t + 0.02, 0.3, { ftype: 'bandpass', f0: 1800, f1: 600, q: 0.8, vol: 0.28 });
  },
  hit(sp) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    tone(o, t, 0.16, { type: 'sine', f0: 220, f1: 70, vol: 0.45 });
    noise(o, t, 0.12, { ftype: 'bandpass', f0: 1500, q: 1, vol: 0.3 });
  },
  hurt() { if (!ctx) return; const t = now(); tone(sfxBus, t, 0.25, { type: 'sawtooth', f0: 260, f1: 90, vol: 0.2 }); noise(sfxBus, t, 0.2, { ftype: 'lowpass', f0: 900, f1: 200, vol: 0.25 }); },
  // взрыв: низкий удар, шипящий шум и треск обломков
  explosion(sp, size = 1) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    tone(o, t, 0.9 * size, { type: 'sine', f0: 95, f1: 28, vol: 0.9 });
    noise(o, t, 0.8 * size, { ftype: 'lowpass', f0: 3500, f1: 120, vol: 0.7 });
    noise(o, t, 0.25, { ftype: 'highpass', f0: 4000, vol: 0.3 });
    for (let i = 0; i < 5; i++) noise(o, t + rnd(0.05, 0.5), 0.07, { ftype: 'bandpass', f0: rnd(1500, 4500), q: 2, vol: 0.18 });
  },
  // машина разбита: взрыв + звон металла и сыплющиеся детали
  wreck(sp) {
    if (!ctx) return;
    sfx.explosion(sp, 1.5);
    const o = out(sp);
    const t = now();
    for (let i = 0; i < 9; i++) tone(o, t + rnd(0.1, 0.9), 0.14, { type: 'square', f0: rnd(500, 2200), f1: rnd(300, 900), vol: 0.07 });
    noise(o, t + 0.1, 0.9, { ftype: 'bandpass', f0: 700, f1: 250, q: 0.7, vol: 0.4 });
  },
  // падение в лаву: свист вниз, всплеск, шипение и бульканье
  fall() { if (!ctx) return; tone(sfxBus, now(), 0.9, { type: 'sine', f0: 1000, f1: 160, vol: 0.2 }); },
  lavaSplash(sp) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    noise(o, t, 0.5, { ftype: 'lowpass', f0: 1600, f1: 200, vol: 0.7 });
    tone(o, t, 0.4, { type: 'sine', f0: 140, f1: 45, vol: 0.6 });
    noise(o, t + 0.1, 1.6, { ftype: 'highpass', f0: 3000, vol: 0.28, a: 0.15 });
    for (let i = 0; i < 9; i++) tone(o, t + 0.15 + i * rnd(0.07, 0.16), 0.09, { type: 'sine', f0: rnd(180, 420), f1: rnd(500, 900), vol: 0.14 });
  },
  jump(sp) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    noise(o, t, 0.28, { ftype: 'bandpass', f0: 300, f1: 1600, q: 1.2, vol: 0.3 });
    tone(o, t, 0.22, { type: 'triangle', f0: 190, f1: 420, vol: 0.3 });
  },
  land(sp, p = 0.5) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    tone(o, t, 0.2, { type: 'sine', f0: 120, f1: 45, vol: 0.45 * (0.4 + p) });
    noise(o, t, 0.14, { ftype: 'lowpass', f0: 1200, f1: 200, vol: 0.3 * (0.4 + p) });
  },
  pickup() { if (!ctx) return; const t = now(); [660, 880, 1320].forEach((f, i) => tone(sfxBus, t + i * 0.06, 0.2, { type: 'triangle', f0: f, vol: 0.2 })); },
  launch(sp) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    noise(o, t, 0.7, { ftype: 'bandpass', f0: 500, f1: 3200, q: 0.9, vol: 0.35 });
    tone(o, t, 0.6, { type: 'sawtooth', f0: 140, f1: 700, vol: 0.18 });
  },
  bow(sp) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    tone(o, t, 0.25, { type: 'triangle', f0: 260, f1: 85, vol: 0.4 });
    noise(o, t, 0.08, { ftype: 'highpass', f0: 3000, vol: 0.2 });
    noise(o, t + 0.04, 0.4, { ftype: 'bandpass', f0: 2500, f1: 900, q: 1, vol: 0.2 });
  },
  glove(sp) {
    if (!ctx) return;
    const o = out(sp);
    const t = now();
    noise(o, t, 0.15, { ftype: 'lowpass', f0: 2200, f1: 300, vol: 0.55 });
    tone(o, t, 0.25, { type: 'sine', f0: 150, f1: 40, vol: 0.7 });
  },
  blast(sp) { if (!ctx) return; sfx.explosion(sp, 0.9); const o = out(sp); tone(o, now(), 0.6, { type: 'sawtooth', f0: 400, f1: 80, vol: 0.15 }); },
  shield() { if (!ctx) return; const t = now(); [523, 784, 1047, 1568].forEach((f, i) => tone(sfxBus, t + i * 0.05, 0.4, { type: 'sine', f0: f, vol: 0.14 })); },
  shieldBreak(sp) { if (!ctx) return; const o = out(sp); const t = now(); noise(o, t, 0.3, { ftype: 'highpass', f0: 3500, vol: 0.4 }); tone(o, t, 0.3, { type: 'square', f0: 1700, f1: 400, vol: 0.12 }); },
  win() { if (!ctx) return; const t = now(); [523, 659, 784, 1047, 1319].forEach((f, i) => { tone(sfxBus, t + i * 0.12, 0.5, { type: 'triangle', f0: f, vol: 0.22 }); tone(sfxBus, t + i * 0.12, 0.5, { type: 'sawtooth', f0: f / 2, vol: 0.06 }); }); },
  lose() { if (!ctx) return; const t = now(); [392, 330, 262, 196].forEach((f, i) => tone(sfxBus, t + i * 0.17, 0.45, { type: 'triangle', f0: f, vol: 0.22 })); },
};

// ---------------------------------------------------------------- двигатель игрока
let eng = null;
export const engine = {
  start() {
    if (!ctx || eng) return;
    const g = ctx.createGain();
    g.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    const o3 = ctx.createOscillator();
    o3.type = 'sine';
    for (const o of [o1, o2, o3]) { o.connect(lp); o.start(); }
    lp.connect(g);
    g.connect(sfxBus);
    // ветер и шум шин
    const ns = ctx.createBufferSource();
    ns.buffer = noiseBuf;
    ns.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.value = 0;
    ns.connect(nf);
    nf.connect(ng);
    ng.connect(sfxBus);
    ns.start();
    eng = { g, lp, o1, o2, o3, ng, nf, ns };
  },
  // ratio 0..1 — скорость относительно максимальной, thr 0..1 — газ, air — в прыжке
  set(ratio, thr, air) {
    if (!eng) return;
    const t = now();
    const f = 48 + ratio * 95 + thr * 14;
    eng.o1.frequency.setTargetAtTime(f, t, 0.06);
    eng.o2.frequency.setTargetAtTime(f * 0.5, t, 0.06);
    eng.o3.frequency.setTargetAtTime(f * 0.25, t, 0.06);
    eng.lp.frequency.setTargetAtTime(500 + ratio * 1500 + thr * 500, t, 0.08);
    eng.g.gain.setTargetAtTime(air ? 0.02 : 0.045 + thr * 0.05, t, 0.08);
    eng.ng.gain.setTargetAtTime(ratio * ratio * 0.09, t, 0.1);
    eng.nf.frequency.setTargetAtTime(500 + ratio * 1800, t, 0.1);
  },
  stop() {
    if (!eng) return;
    const e = eng;
    eng = null;
    const t = now();
    e.g.gain.setTargetAtTime(0, t, 0.1);
    e.ng.gain.setTargetAtTime(0, t, 0.1);
    setTimeout(() => { try { e.o1.stop(); e.o2.stop(); e.o3.stop(); e.ns.stop(); } catch { /* уже остановлено */ } }, 600);
  },
};

// ---------------------------------------------------------------- толпа на трибунах
let amb = null;
export const crowd = {
  // постоянный гул трибун, его громкость плавает
  start() {
    if (!ctx || amb) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 650;
    bp.Q.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const g = ctx.createGain();
    g.gain.value = 0.0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.17;
    const lg = ctx.createGain();
    lg.gain.value = 0.08;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(bp);
    bp.connect(lp);
    lp.connect(g);
    g.connect(crowdBus);
    src.start();
    lfo.start();
    g.gain.setTargetAtTime(0.4, now(), 1.2);
    amb = { src, lfo, g };
  },
  stop() {
    if (!amb) return;
    const a = amb;
    amb = null;
    a.g.gain.setTargetAtTime(0, now(), 0.4);
    setTimeout(() => { try { a.src.stop(); a.lfo.stop(); } catch { /* уже остановлено */ } }, 1500);
  },
  // общий накал: 0 — спокойно, 1 — трибуны ревут
  level(x) { if (amb) amb.g.gain.setTargetAtTime(0.3 + 0.6 * x, now(), 0.5); },
  // несколько «голосов» с формантами: получается похоже на «а-а-а!» / «у-у-у!»
  voices(kind, dur, count, vol) {
    if (!ctx) return;
    const t = now();
    for (let i = 0; i < count; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const base = rnd(150, 300);
      const up = kind === 'cheer';
      o.frequency.setValueAtTime(base * (up ? 0.85 : 1.1), t);
      o.frequency.linearRampToValueAtTime(base * (up ? 1.2 : 0.7), t + dur);
      const vib = ctx.createOscillator();
      vib.frequency.value = rnd(4.5, 6.5);
      const vg = ctx.createGain();
      vg.gain.value = 5;
      vib.connect(vg);
      vg.connect(o.frequency);
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = kind === 'ooh' ? 420 : kind === 'gasp' ? 900 : 760;
      f1.Q.value = 3;
      const f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = kind === 'ooh' ? 800 : 1300;
      f2.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + rnd(0, 0.12));
      g.gain.exponentialRampToValueAtTime(vol / count, t + 0.25);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) p.pan.value = rnd(-0.9, 0.9);
      o.connect(f1);
      o.connect(f2);
      f1.connect(g);
      f2.connect(g);
      if (p) { g.connect(p); p.connect(crowdBus); } else g.connect(crowdBus);
      o.start(t);
      vib.start(t);
      o.stop(t + dur + 0.05);
      vib.stop(t + dur + 0.05);
    }
  },
  applause(dur = 2.4, vol = 1.1) {
    if (!ctx) return;
    const t = now();
    const src = ctx.createBufferSource();
    src.buffer = applauseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.35);
    g.gain.setValueAtTime(vol, t + Math.max(0.4, dur - 0.9));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(crowdBus);
    src.start(t);
    src.stop(t + Math.min(dur, 2.95));
  },
  // громкий восторг: рёв толпы + выкрики + аплодисменты
  cheer(power = 0.7) {
    if (!ctx) return;
    const t = now();
    noise(crowdBus, t, 1.4 + power, { ftype: 'bandpass', f0: 700, f1: 1500, q: 0.8, vol: 0.25 + 0.2 * power, a: 0.3 });
    crowd.voices('cheer', 1.2 + power, 7, 0.5 * (0.5 + power));
    crowd.applause(1.8 + 2 * power, 0.8 + 0.7 * power);
  },
  ooh() { crowd.voices('ooh', 1.3, 6, 0.45); if (ctx) noise(crowdBus, now(), 1.2, { ftype: 'bandpass', f0: 500, f1: 350, q: 0.8, vol: 0.18, a: 0.2 }); },
  gasp() { if (!ctx) return; noise(crowdBus, now(), 0.7, { ftype: 'bandpass', f0: 1500, f1: 700, q: 0.8, vol: 0.3, a: 0.2 }); crowd.voices('gasp', 0.8, 5, 0.4); },
};

// ---------------------------------------------------------------- музыка: 7 треков по порядку
const NAMES = ['Neon Drive', 'Lava Run', 'Turbo Night', 'Skyline', 'Overdrive', 'Midnight Garage', 'Final Lap'];
const MAJ = [0, 2, 4, 5, 7, 9, 11];
const MIN = [0, 2, 3, 5, 7, 8, 10];
const PHR = [0, 1, 3, 5, 7, 8, 10];
// prog — аккорды (ступени лада, по одному на такт), drums — рисунок ударных, bass — рисунок баса, lead — тип мелодии
const TRACKS = [
  { name: NAMES[0], bpm: 124, root: 57, scale: MIN, prog: [0, 5, 2, 6], drums: 'four', bass: 'eighth', lead: 'arp', leadWave: 'square', pad: true, seed: 11 },
  { name: NAMES[1], bpm: 140, root: 50, scale: PHR, prog: [0, 1, 0, 6], drums: 'break', bass: 'eighth', lead: 'melody', leadWave: 'sawtooth', pad: false, seed: 23 },
  { name: NAMES[2], bpm: 128, root: 53, scale: MIN, prog: [0, 3, 5, 4], drums: 'four', bass: 'offbeat', lead: 'pluck', leadWave: 'triangle', pad: true, seed: 37 },
  { name: NAMES[3], bpm: 110, root: 60, scale: MAJ, prog: [0, 4, 5, 3], drums: 'half', bass: 'long', lead: 'melody', leadWave: 'triangle', pad: true, seed: 41 },
  { name: NAMES[4], bpm: 150, root: 52, scale: MIN, prog: [0, 5, 6, 0], drums: 'break', bass: 'offbeat', lead: 'arp', leadWave: 'sawtooth', pad: false, seed: 53 },
  { name: NAMES[5], bpm: 98, root: 55, scale: MIN, prog: [0, 3, 6, 2], drums: 'half', bass: 'long', lead: 'pluck', leadWave: 'triangle', pad: true, seed: 67 },
  { name: NAMES[6], bpm: 160, root: 59, scale: MIN, prog: [0, 5, 3, 4], drums: 'dnb', bass: 'eighth', lead: 'melody', leadWave: 'sawtooth', pad: true, seed: 79 },
];
const BARS = 32;

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const noteOf = (T, deg) => T.root + T.scale[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);

// заранее придумываем мелодию и арпеджио для каждого аккорда
for (const T of TRACKS) {
  const r = seeded(T.seed);
  T.motifs = T.prog.map((d) => {
    const pool = [d, d + 2, d + 4, d + 7, d + 1, d + 6, d + 9];
    const arr = [];
    for (let s = 0; s < 16; s++) {
      const strong = s % 4 === 0;
      arr.push(r() < (strong ? 0.85 : 0.42) ? pool[(r() * (strong ? 4 : pool.length)) | 0] : null);
    }
    return arr;
  });
}

const M = { idx: 0, timer: null, step: 0, next: 0, T: null, ext: new Array(7).fill(false), audio: null, on: false, volGain: null };

function kick(t, v = 0.9) { tone(musBus, t, 0.35, { type: 'sine', f0: 150, f1: 42, vol: v, a: 0.002 }); }
function snare(t, v = 0.45) { noise(musBus, t, 0.2, { ftype: 'bandpass', f0: 1900, q: 0.8, vol: v }); tone(musBus, t, 0.14, { type: 'triangle', f0: 200, f1: 150, vol: v * 0.7 }); }
function hat(t, open, v = 0.12) { noise(musBus, t, open ? 0.2 : 0.045, { ftype: 'highpass', f0: 7500, vol: v }); }
function clap(t) { for (let i = 0; i < 3; i++) noise(musBus, t + i * 0.012, 0.09, { ftype: 'bandpass', f0: 1500, q: 1.2, vol: 0.25 }); }

function bassNote(t, midi, dur, wave = 'sawtooth') {
  const f = mtof(midi);
  const osc = ctx.createOscillator();
  osc.type = wave;
  osc.frequency.value = f;
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = f;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 4;
  lp.frequency.setValueAtTime(900, t);
  lp.frequency.exponentialRampToValueAtTime(180, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(lp);
  sub.connect(g);
  lp.connect(g);
  g.connect(musBus);
  osc.start(t); sub.start(t);
  osc.stop(t + dur + 0.03); sub.stop(t + dur + 0.03);
}
function leadNote(t, midi, dur, wave) {
  for (const det of [-6, 6]) {
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = mtof(midi);
    osc.detune.value = det;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3800, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.085, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp);
    lp.connect(g);
    g.connect(musBus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }
}
function padChord(t, midis, dur) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1100;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.07, t + 0.5);
  g.gain.setValueAtTime(0.07, t + dur - 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  lp.connect(g);
  g.connect(musBus);
  for (const m of midis) {
    for (const det of [-9, 0, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }
}

function scheduleStep(T, step, t, spb) {
  const bar = (step / 16) | 0;
  const s = step % 16;
  const sec = Math.min(3, (bar / 8) | 0); // 0 вступление, 1 +бас/арпеджио, 2 +мелодия, 3 полный
  const ci = bar % T.prog.length;
  const deg = T.prog[ci];
  const last = bar === BARS - 1;

  // ударные
  const dr = T.drums;
  if (dr === 'four') {
    if (s % 4 === 0) kick(t);
    if (s === 4 || s === 12) { if (sec >= 1) clap(t); }
    if (s % 4 === 2) hat(t, true);
    else if (sec >= 2 && s % 2 === 1) hat(t, false, 0.07);
  } else if (dr === 'break' || dr === 'dnb') {
    const ks = dr === 'dnb' ? [0, 10] : [0, 7, 10];
    if (ks.includes(s)) kick(t);
    if (s === 4 || s === 12) snare(t);
    if (s % 2 === 0 || dr === 'dnb') hat(t, s % 8 === 6, dr === 'dnb' ? 0.08 : 0.11);
  } else {
    if (s === 0 || s === 10) kick(t, 0.8);
    if (s === 8) snare(t, 0.4);
    if (s % 2 === 0) hat(t, false, 0.09);
  }
  if (sec >= 3 && s === 15 && bar % 4 === 3) snare(t, 0.35);

  // бас
  const bn = noteOf(T, deg) - 24;
  if (sec >= 1 || bar >= 2) {
    if (T.bass === 'eighth' && s % 2 === 0) bassNote(t, bn + (s % 8 === 6 ? 7 : 0), spb * 1.8);
    else if (T.bass === 'offbeat' && s % 4 === 2) bassNote(t, bn, spb * 3);
    else if (T.bass === 'long' && (s === 0 || s === 8)) bassNote(t, bn, spb * 7, 'triangle');
  }

  // пэд: один аккорд на такт
  if (T.pad && s === 0) padChord(t, [0, 2, 4].map((d) => noteOf(T, deg + d)), spb * 16);

  // арпеджио / мелодия
  const oct = sec >= 3 && bar % 8 >= 4 ? 12 : 0;
  if (T.lead === 'arp' && sec >= 1) {
    const seq = [0, 2, 4, 2, 7, 4, 2, 4];
    if (s % 2 === 0) leadNote(t, noteOf(T, deg + seq[(s / 2) % 8]) + 12 + oct, spb * 1.6, T.leadWave);
  } else if (sec >= 2 || (T.lead !== 'arp' && sec >= 1 && bar % 2 === 1)) {
    const d2 = T.motifs[ci][s];
    if (d2 !== null) leadNote(t, noteOf(T, d2) + 12 + oct, spb * (T.lead === 'pluck' ? 1.4 : 2.4), T.leadWave);
  }
  if (last && s === 0) kick(t, 0.5);
}

function tickMusic() {
  if (!ctx || !M.on) return;
  const T = M.T;
  const spb = 60 / T.bpm / 4;
  while (M.next < ctx.currentTime + 0.3) {
    scheduleStep(T, M.step, M.next, spb);
    M.next += spb;
    M.step++;
    if (M.step >= BARS * 16) {
      musicNext(true);
      return;
    }
  }
}

function probeMusicFiles() {
  for (let i = 0; i < 7; i++) {
    fetch(`music/${i + 1}.mp3`, { method: 'HEAD' })
      .then((r) => { M.ext[i] = r.ok && /audio/.test(r.headers.get('content-type') || ''); })
      .catch(() => {});
  }
}

function stopCurrent() {
  if (M.timer) { clearInterval(M.timer); M.timer = null; }
  if (M.audio) { M.audio.pause(); M.audio = null; }
}

function startTrack(i) {
  stopCurrent();
  M.idx = i;
  M.T = TRACKS[i];
  M.on = true;
  if (M.ext[i]) {
    // свой файл: public/music/<номер>.mp3
    const a = new Audio(`music/${i + 1}.mp3`);
    a.addEventListener('ended', () => musicNext(true));
    try {
      const src = ctx.createMediaElementSource(a);
      src.connect(musBus);
    } catch { /* уже подключён */ }
    a.play().catch(() => {});
    M.audio = a;
    return;
  }
  M.step = 0;
  M.next = ctx.currentTime + 0.15;
  M.timer = setInterval(tickMusic, 40);
}

export function musicStart() {
  if (!ctx || M.on) return;
  musBus.gain.cancelScheduledValues(now());
  musBus.gain.setTargetAtTime(S.mus * 0.9, now(), 0.4);
  startTrack(M.idx);
}
export function musicStop() {
  if (!ctx || !M.on) return;
  M.on = false;
  musBus.gain.setTargetAtTime(0, now(), 0.25);
  const t = M.timer;
  const a = M.audio;
  setTimeout(() => { if (!M.on) { if (t) clearInterval(t); if (a) a.pause(); if (M.timer === t) M.timer = null; if (M.audio === a) M.audio = null; } }, 900);
}
export function musicNext(auto = false) {
  if (!ctx) return;
  if (!M.on && !auto) return;
  musBus.gain.setTargetAtTime(S.mus * 0.9, now(), 0.1);
  startTrack((M.idx + 1) % TRACKS.length);
}
export const musicName = () => `${M.idx + 1}/${TRACKS.length}  ${TRACKS[M.idx].name}`;
export const musicPlaying = () => M.on;
export const TRACK_COUNT = TRACKS.length;
