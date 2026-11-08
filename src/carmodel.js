// carmodel.js — модели машин.
// 1) Процедурные: кузов выдавливается из бокового профиля (капот, лобовое, крыша, багажник), окна и арки на текстуре,
//    колёса с дисками, фары, зеркала, спойлеры. Детали одного материала склеиваются в один объект (быстро на телефоне).
// 2) Свои модели: положите .glb в public/models/ и опишите в public/models/index.json (см. README) — они заменят процедурные.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;

export const softTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

// ---------------------------------------------------------------- стиль профиля по типу кузова
// pf — наклон лобового (доля длины салона), rear — форма задней части
const STYLE = {
  hatch: { pf: 0.26, rear: 'hatch' },
  sedan: { pf: 0.3, rear: 'notch' },
  pickup: { pf: 0.25, rear: 'bed' },
  coupe: { pf: 0.36, rear: 'fast' },
  buggy: { open: 'cage' },
  suv: { pf: 0.1, rear: 'box' },
  muscle: { pf: 0.34, rear: 'notch', scoop: true },
  roadster: { open: 'open' },
  cabrio: { open: 'open' },
  rally: { pf: 0.28, rear: 'hatch' },
  sport: { pf: 0.4, rear: 'fast' },
  dragster: { pf: 0.3, rear: 'notch' },
  monster: { pf: 0.18, rear: 'box' },
  electric: { pf: 0.36, rear: 'fast' },
  hyper: { pf: 0.4, rear: 'fast' },
  futuro: { pf: 0.42, rear: 'fast' },
};

function makeProfile(def) {
  const b = def.body;
  const st = STYLE[def.kind] || STYLE.sedan;
  const L = b.len;
  const hw = L / 2;
  const yb = b.wr * 0.55;
  const bodyTop = b.wr * 0.9 + b.h;
  const roofTop = bodyTop + b.ch;
  const cx = b.co;
  const cl = b.cl;
  const xwf = cx + cl / 2;
  const xwr = cx - cl / 2;
  const pts = [];
  const rad = [];
  const P = (x, y, r) => { pts.push([x, y]); rad.push(r); };
  P(-hw, yb, 0.12);
  P(hw, yb, 0.12);
  P(hw, yb + b.h * 0.6, 0.16);
  P(hw - 0.3, bodyTop - 0.1, 0.22);
  const prof = { L, yb, bodyTop, roofTop, cx, cl, xwf, xwr, st, win: null, windshield: null, rearglass: null, openTop: !!st.open };
  if (st.open) {
    // открытый верх: низкая рамка лобового и ровная «палуба» сзади
    P(xwf, bodyTop, 0.1);
    P(xwf - 0.28, bodyTop + (st.open === 'cage' ? 0.0 : 0.3), 0.08);
    P(xwf - 0.42, bodyTop + (st.open === 'cage' ? 0.0 : 0.3), 0.06);
    P(xwf - 0.52, bodyTop - 0.02, 0.1);
    P(-hw + 0.2, bodyTop - 0.04, 0.2);
    P(-hw, yb + b.h * 0.65, 0.12);
    prof.windshield = st.open === 'cage' ? null : [[xwf, bodyTop], [xwf - 0.28, bodyTop + 0.3]];
  } else {
    const rf = xwf - cl * st.pf;
    const rrMap = { notch: 0.26, hatch: 0.08, fast: 0.5, box: 0.04, bed: 0.05 };
    const rr = xwr + cl * rrMap[st.rear];
    P(xwf, bodyTop, 0.12);
    P(rf, roofTop, 0.4);
    P(rr, roofTop, 0.4);
    let base;
    if (st.rear === 'notch') { base = [xwr, bodyTop - 0.04]; P(base[0], base[1], 0.12); P(-hw + 0.2, bodyTop - 0.09, 0.22); }
    else if (st.rear === 'hatch') { base = [-hw + 0.2, bodyTop - 0.06]; P(base[0], base[1], 0.2); }
    else if (st.rear === 'fast') { base = [-hw + 0.28, bodyTop - 0.03]; P(base[0], base[1], 0.24); }
    else if (st.rear === 'box') { base = [xwr, bodyTop]; P(base[0], base[1], 0.1); P(-hw + 0.06, bodyTop - 0.02, 0.1); }
    else { base = [xwr, bodyTop - 0.12]; P(base[0], base[1], 0.08); P(-hw + 0.04, bodyTop - 0.12, 0.08); }
    P(-hw, yb + b.h * 0.7, 0.12);
    prof.windshield = [[xwf, bodyTop], [rf, roofTop]];
    prof.rearglass = st.rear === 'box' || st.rear === 'bed' ? null : [[rr, roofTop], base];
    // окна сбоку: сжатый контур салона
    const poly = [[xwf, bodyTop], [rf, roofTop], [rr, roofTop], base];
    const mx = poly.reduce((s, p) => s + p[0], 0) / 4;
    const my = poly.reduce((s, p) => s + p[1], 0) / 4;
    prof.win = poly.map(([x, y]) => [mx + (x - mx) * 0.86, my + (y - my) * 0.74]);
    prof.winMid = mx;
  }
  prof.pts = pts;
  prof.rad = rad;
  return prof;
}

function roundedShape(pts, rad) {
  const sh = new THREE.Shape();
  const n = pts.length;
  const dir = (a, b) => { const dx = b[0] - a[0]; const dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l, l]; };
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i + n - 1) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const [ax, ay, al] = dir(p1, p0);
    const [bx, by, bl] = dir(p1, p2);
    const r = Math.min(rad[i], al * 0.45, bl * 0.45);
    const s = [p1[0] + ax * r, p1[1] + ay * r];
    const e = [p1[0] + bx * r, p1[1] + by * r];
    if (i === 0) sh.moveTo(s[0], s[1]);
    else sh.lineTo(s[0], s[1]);
    sh.quadraticCurveTo(p1[0], p1[1], e[0], e[1]);
  }
  sh.closePath();
  return sh;
}

// текстуры боковин: белое = краска, тёмное = стёкла и нижний пластик; вторая — шероховатость/металл
function sideTextures(prof) {
  const W = 512;
  const th = prof.roofTop + 0.25;
  const H = Math.round((W * th) / prof.L);
  const mk = (bodyCol, glassCol, trimCol, drawWin) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = bodyCol;
    g.fillRect(0, 0, W, H);
    const X = (x) => ((x + prof.L / 2) / prof.L) * W;
    const Y = (y) => (1 - y / th) * H;
    // нижний пластиковый порог
    g.fillStyle = trimCol;
    g.fillRect(0, Y(prof.yb + 0.2), W, Y(0) - Y(prof.yb + 0.2));
    if (prof.win) {
      const stroke = (poly) => { g.beginPath(); poly.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.closePath(); g.fill(); };
      g.fillStyle = glassCol;
      stroke(prof.win);
      // стойка между дверями
      g.fillStyle = bodyCol;
      const mx = X(prof.winMid - 0.05);
      g.fillRect(mx, Y(prof.roofTop), 7, Y(prof.bodyTop) - Y(prof.roofTop));
      if (drawWin === 'lines') {
        g.fillStyle = trimCol;
        g.fillRect(X(prof.winMid + 0.55), Y(prof.bodyTop), 2, Y(prof.yb + 0.2) - Y(prof.bodyTop));
        g.fillRect(X(prof.winMid - 0.62), Y(prof.bodyTop), 2, Y(prof.yb + 0.2) - Y(prof.bodyTop));
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 4;
    t.repeat.set(1 / prof.L, 1 / th);
    t.offset.set(0.5, 0);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  };
  const map = mk('#ffffff', '#16283a', '#1b1d22', 'lines');
  map.colorSpace = THREE.SRGBColorSpace;
  // зелёный канал — шероховатость, синий — металличность
  const rm = mk('rgb(0,74,175)', 'rgb(0,10,235)', 'rgb(0,230,20)', null);
  return { map, rm };
}

// ---------------------------------------------------------------- склейка мелких деталей
class Merger {
  constructor() { this.parts = {}; this.m = new THREE.Matrix4(); }
  add(key, geo, x, y, z, rx = 0, ry = 0, rz = 0) {
    const g = geo.clone();
    this.m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
    this.m.setPosition(x, y, z);
    g.applyMatrix4(this.m);
    (this.parts[key] = this.parts[key] || []).push(g);
  }
  box(key, w, h, d, x, y, z, rx, ry, rz) { this.add(key, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz); }
  cyl(key, r0, r1, h, x, y, z, rx, ry, rz, seg = 10) { this.add(key, new THREE.CylinderGeometry(r0, r1, h, seg), x, y, z, rx, ry, rz); }
  build(mats, parent, cast) {
    for (const k in this.parts) {
      const geo = mergeGeometries(this.parts[k], false);
      if (!geo) continue;
      const m = new THREE.Mesh(geo, mats[k]);
      m.castShadow = !!cast[k];
      parent.add(m);
    }
  }
}

const matCache = new Map();
function stdMat(color, rough, metal, extra) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });
}

// ---------------------------------------------------------------- щит: полупрозрачный пузырь с сеткой и бликом по краю
const SHIELD_VERT = `
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); vP = position; gl_Position = projectionMatrix * mv; }`;
const SHIELD_FRAG = `
uniform float uTime; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
  float f = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.2);
  float g = abs(sin(vP.x*3.2 + uTime*1.5)) * abs(sin(vP.y*3.2 - uTime)) * abs(sin(vP.z*3.2 + uTime*0.7));
  float hex = smoothstep(0.55, 0.95, g);
  float a = f*0.85 + hex*0.18 + 0.05;
  gl_FragColor = vec4(uColor * (0.8 + f), a);
}`;

// ---------------------------------------------------------------- сборка машины
export function buildCar(def, isPlayer, team, quality = 'game') {
  const g = new THREE.Group();
  const b = def.body;
  const prof = makeProfile(def);
  const wheelY = b.wr;
  const show = quality === 'show';

  // кузов: выдавленный профиль
  const bevel = 0.11;
  const depth = b.wid * 0.9 - bevel * 2;
  const geo = new THREE.ExtrudeGeometry(roundedShape(prof.pts, prof.rad), {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: show ? 5 : 3,
    curveSegments: show ? 10 : 6,
  });
  geo.translate(0, 0, -depth / 2);
  const tex = sideTextures(prof);
  const PaintMat = show ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const extra = show ? { clearcoat: 1, clearcoatRoughness: 0.04 } : {};
  const ghost = def.ghost ? { transparent: true, opacity: 0.8 } : {};
  const sideMat = new PaintMat({ color: def.color, map: tex.map, roughness: 1, metalness: 1, roughnessMap: tex.rm, metalnessMap: tex.rm, ...extra, ...ghost });
  const wallMat = new PaintMat({ color: def.color, roughness: 0.29, metalness: 0.65, ...extra, ...ghost });
  const body = new THREE.Mesh(geo, [sideMat, wallMat]);
  body.castShadow = true;
  g.add(body);

  const M = new Merger();
  const dark = 'dark';
  const chrome = 'chrome';
  const lampH = 'lampH';
  const lampT = 'lampT';
  const accent = 'accent';
  const glass = 'glass';
  const hw = b.len / 2;
  const w2 = b.wid / 2;

  // арки колёс: тёмные диски вровень с боковиной, колесо торчит из них
  const archR = Math.min(b.wr * 1.16, prof.bodyTop - wheelY - 0.03);
  for (const sx of [-1, 1]) {
    M.cyl(dark, archR, archR, b.wid * 0.9 + 0.02, sx * b.len * 0.31, wheelY, 0, Math.PI / 2, 0, 0, 20);
  }
  // бамперы, решётка, сплиттер, диффузор
  M.box(dark, 0.26, b.h * 0.42, b.wid * 0.92, hw - 0.04, prof.yb + b.h * 0.22, 0);
  M.box(dark, 0.26, b.h * 0.42, b.wid * 0.92, -hw + 0.04, prof.yb + b.h * 0.22, 0);
  M.box(dark, 0.08, b.h * 0.26, b.wid * 0.46, hw + 0.02, prof.yb + b.h * 0.58, 0);
  if (['sport', 'hyper', 'futuro', 'dragster', 'rally', 'muscle'].includes(def.kind)) {
    M.box(dark, 0.5, 0.05, b.wid * 0.96, hw - 0.05, prof.yb + 0.03, 0);
    M.box(dark, 0.4, 0.05, b.wid * 0.9, -hw + 0.05, prof.yb + 0.04, 0);
  }
  // пороги
  for (const sz of [-1, 1]) M.box(dark, b.len * 0.42, 0.1, 0.06, 0, prof.yb + 0.05, sz * (w2 * 0.9 + 0.02));
  // фары и задние огни
  for (const sz of [-1, 1]) {
    M.box(lampH, 0.14, 0.17, 0.44, hw - 0.03, prof.bodyTop - 0.22, sz * b.wid * 0.33);
    M.box(lampT, 0.12, 0.14, 0.42, -hw + 0.02, prof.bodyTop - 0.28, sz * b.wid * 0.33);
  }
  if (['electric', 'futuro', 'hyper'].includes(def.kind)) {
    M.box(lampH, 0.06, 0.05, b.wid * 0.74, hw + 0.01, prof.bodyTop - 0.34, 0);
    M.box(lampT, 0.06, 0.06, b.wid * 0.8, -hw - 0.01, prof.bodyTop - 0.28, 0);
  }
  // зеркала
  if (!prof.openTop || def.kind !== 'buggy') {
    for (const sz of [-1, 1]) {
      M.box(accent, 0.2, 0.12, 0.1, prof.xwf - 0.12, prof.bodyTop + 0.14, sz * (w2 * 0.95 + 0.08));
      M.box(dark, 0.04, 0.1, 0.12, prof.xwf - 0.12, prof.bodyTop + 0.14, sz * (w2 * 0.95 + 0.14));
    }
  }
  // выхлопные трубы
  if (['muscle', 'sport', 'rally', 'dragster', 'hyper', 'coupe', 'roadster'].includes(def.kind)) {
    for (const sz of [-1, 1]) M.cyl(chrome, 0.1, 0.1, 0.24, -hw - 0.02, prof.yb + 0.16, sz * b.wid * 0.26, 0, 0, Math.PI / 2, 12);
  }
  // номерной знак
  M.box('plate', 0.03, 0.14, 0.38, -hw - 0.01, prof.yb + b.h * 0.5, 0);

  // лобовое и заднее стекло: тёмные глянцевые пластины по линии профиля
  const glassPlane = (p, q, off) => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    const nx = dy / len;
    const ny = -dx / len;
    const geom = new THREE.PlaneGeometry(len, b.wid * 0.78);
    geom.rotateX(-Math.PI / 2);
    const ang = Math.atan2(dy, dx);
    M.add(glass, geom, (p[0] + q[0]) / 2 + nx * off, (p[1] + q[1]) / 2 + ny * off, 0, 0, 0, ang);
  };
  if (prof.windshield) glassPlane(prof.windshield[0], prof.windshield[1], 0.03);
  if (prof.rearglass) {
    const [p, q] = prof.rearglass;
    glassPlane(p, q, 0.03);
  }

  // особенности типов
  if (STYLE[def.kind] && STYLE[def.kind].scoop) {
    M.box(dark, 0.7, 0.1, 0.5, prof.xwf + 0.55, prof.bodyTop + 0.05, 0);
  }
  if (def.kind === 'pickup') {
    M.box(dark, b.len * 0.36, 0.02, b.wid * 0.74, -hw + b.len * 0.2, prof.bodyTop - 0.1, 0); // кузов пикапа внутри
  }
  if (prof.openTop) {
    // кокпит с сиденьями
    M.box(dark, 0.9, 0.03, b.wid * 0.7, prof.xwf - 1.0, prof.bodyTop + 0.005, 0);
    for (const sz of [-1, 1]) {
      M.box('seat', 0.34, 0.26, 0.4, prof.xwf - 1.0, prof.bodyTop + 0.14, sz * b.wid * 0.18);
      M.box('seat', 0.1, 0.4, 0.4, prof.xwf - 1.22, prof.bodyTop + 0.3, sz * b.wid * 0.18);
    }
  }
  if (def.kind === 'buggy') {
    // каркас безопасности
    const cx0 = prof.xwf - 0.9;
    for (const sz of [-1, 1]) {
      M.cyl(accent, 0.06, 0.06, 0.9, cx0 + 0.45, prof.bodyTop + 0.45, sz * b.wid * 0.32, 0, 0, 0.25, 8);
      M.cyl(accent, 0.06, 0.06, 0.9, cx0 - 0.45, prof.bodyTop + 0.45, sz * b.wid * 0.32, 0, 0, -0.2, 8);
      M.cyl(accent, 0.06, 0.06, 1.0, cx0, prof.bodyTop + 0.88, sz * b.wid * 0.32, 0, 0, Math.PI / 2, 8);
    }
    M.cyl(accent, 0.06, 0.06, b.wid * 0.64, cx0, prof.bodyTop + 0.88, 0, Math.PI / 2, 0, 0, 8);
  }
  // гоночные полосы по линии капота, крыши и багажника
  if (b.stripe) {
    const pts = prof.pts;
    const seg = (a, c) => {
      const dx = c[0] - a[0];
      const dy = c[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (len < 0.2) return;
      M.add(accent, new THREE.BoxGeometry(len, 0.012, 0.3), (a[0] + c[0]) / 2, (a[1] + c[1]) / 2 + 0.06, 0, 0, 0, Math.atan2(dy, dx));
    };
    for (let i = 3; i < pts.length - 1; i++) seg(pts[i], pts[i + 1]);
  }
  // антикрыло
  if (b.spoiler) {
    M.box(accent, 0.42, 0.08, b.wid * 0.96, -hw + 0.12, prof.bodyTop + 0.5, 0);
    for (const sz of [-1, 1]) M.box(dark, 0.08, 0.46, 0.08, -hw + 0.12, prof.bodyTop + 0.26, sz * b.wid * 0.3);
    for (const sz of [-1, 1]) M.box(accent, 0.46, 0.22, 0.05, -hw + 0.12, prof.bodyTop + 0.55, sz * b.wid * 0.48);
  }
  const mats = {
    dark: stdMat(0x14161c, 0.55, 0.25),
    chrome: stdMat(0xd7dde8, 0.15, 1),
    lampH: new THREE.MeshBasicMaterial({ color: 0xfff4c4, toneMapped: false }),
    lampT: new THREE.MeshBasicMaterial({ color: 0xff2020, toneMapped: false }),
    accent: stdMat(def.accent, 0.35, 0.4),
    plate: stdMat(0xf2f2f2, 0.6, 0),
    seat: stdMat(0x23262e, 0.8, 0),
    glass: new THREE.MeshStandardMaterial({ color: 0x0b1622, roughness: 0.06, metalness: 0.9, side: THREE.DoubleSide }),
  };
  M.build(mats, g, { dark: true, accent: true });

  // колёса: покрышка, диск с пятью спицами, тормозной диск; вращаются при езде
  const tireM = stdMat(0x0f0f12, 0.92, 0);
  const rimM = stdMat(0xd9dfea, 0.2, 1);
  const discM = stdMat(0x4b4f5a, 0.5, 0.8);
  const tg = new THREE.CylinderGeometry(b.wr, b.wr, 0.46, show ? 28 : 18);
  const dg = new THREE.CylinderGeometry(b.wr * 0.66, b.wr * 0.66, 0.5, show ? 24 : 14);
  const bg = new THREE.CylinderGeometry(b.wr * 0.46, b.wr * 0.46, 0.51, 12);
  const sg = new THREE.BoxGeometry(b.wr * 1.22, 0.53, b.wr * 0.13);
  const wheels = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const piv = new THREE.Group();
      piv.position.set(sx * b.len * 0.31, wheelY, sz * (b.wid / 2 - 0.02));
      const inner = new THREE.Group();
      inner.rotation.x = Math.PI / 2;
      const tire = new THREE.Mesh(tg, tireM);
      tire.castShadow = true;
      inner.add(tire);
      inner.add(new THREE.Mesh(dg, rimM));
      inner.add(new THREE.Mesh(bg, discM));
      for (let k = 0; k < 5; k++) {
        const sp = new THREE.Mesh(sg, discM);
        sp.rotation.y = (k / 5) * Math.PI;
        inner.add(sp);
      }
      piv.add(inner);
      g.add(piv);
      wheels.push(piv);
    }
  }
  // свечение днища: цвет команды или особый цвет машины
  {
    const gl = new THREE.Mesh(
      new THREE.PlaneGeometry(b.len * 1.4, b.wid * 1.5),
      new THREE.MeshBasicMaterial({ color: def.glow || parseInt(team.slice(1), 16), map: softTex, transparent: true, opacity: def.glow ? 0.9 : 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    gl.rotation.x = -Math.PI / 2;
    gl.position.y = 0.1;
    g.add(gl);
  }
  g.scale.setScalar(1.3);

  const holder = new THREE.Group();
  holder.add(g);
  if (isPlayer) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.1, 40),
      new THREE.MeshBasicMaterial({ color: 0x7dffb0, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.09;
    holder.add(ring);
  }
  const shieldMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x4cc9ff) } },
    vertexShader: SHIELD_VERT,
    fragmentShader: SHIELD_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const shield = new THREE.Mesh(new THREE.SphereGeometry(3.1, 24, 16), shieldMat);
  shield.position.y = 1.3;
  shield.visible = false;
  holder.add(shield);

  const view = { holder, body: g, shield, shieldMat, wheels, paint: wallMat, paintSide: sideMat, flash: 0, tiltX: 0, tiltZ: 0, def, custom: false };
  tryCustomModel(view, def);
  return view;
}

// ---------------------------------------------------------------- свои .glb-модели
let modelIndex = null; // { "car0": { "file": "taxi.glb", "rotY": 0, "scale": 1, "y": 0 }, ... }
let indexLoading = null;
export function probeModels() {
  if (indexLoading) return indexLoading;
  indexLoading = fetch('models/index.json')
    .then((r) => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : null))
    .then((j) => { modelIndex = j && typeof j === 'object' ? j : {}; })
    .catch(() => { modelIndex = {}; });
  return indexLoading;
}
const glbCache = new Map();
function tryCustomModel(view, def) {
  probeModels().then(() => {
    const e = modelIndex && modelIndex['car' + def.id];
    if (!e || !e.file) return;
    const url = 'models/' + e.file;
    let p = glbCache.get(url);
    if (!p) {
      p = new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
      glbCache.set(url, p);
    }
    p.then((gltf) => {
      const m = gltf.scene.clone(true);
      const box = new THREE.Box3().setFromObject(m);
      const size = new THREE.Vector3();
      box.getSize(size);
      const len = Math.max(size.x, size.z) || 1;
      const s = ((def.body.len * 1.3 * 1.15) / len) * (e.scale || 1);
      m.scale.setScalar(s);
      m.rotation.y = e.rotY || 0;
      const b2 = new THREE.Box3().setFromObject(m);
      m.position.y -= b2.min.y - (e.y || 0);
      m.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
      // прячем процедурную модель, оставляя свечение и кольцо
      view.body.children.forEach((c) => { if (!(c.material && c.material.blending === THREE.AdditiveBlending)) c.visible = false; });
      view.wheels.length = 0;
      view.holder.add(m);
      view.custom = true;
    }).catch(() => {});
  });
}
