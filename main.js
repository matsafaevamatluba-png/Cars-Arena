import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createWorld, stepWorld, angDiff, R_FLAT, R_TOP, WALL_H, LAVA_Y, MAX_HP, JUMP_CD, ABILITIES, SPEED_MUL } from './sim.js';
import { CARS } from './cars.js';
import { ARENAS } from './arenas.js';
import { S, persist, levelInfo, applyReward, MAX_LEVEL, ICONS, BOX_PRICE } from './store.js';
import { buildCar, softTex } from './carmodel.js';
import { createShowroom } from './showroom.js';
import * as A from './audio.js';
import * as N from './net.js';

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const ICON = { shield: '🛡️', missile: '🚀', blast: '💥', bow: '🏹', glove: '🥊' };
const PAD_COLOR = { shield: 0x38bdf8, missile: 0xef4444, blast: 0xff8a1f, bow: 0x4ade80, glove: 0xfacc15 };
const CAR_COLORS = ['#4ade80', '#ff5d5d', '#5db7ff', '#ffd23f'];
const BOT_NAMES = ['Макс', 'Рокет', 'Турбо', 'Дрифт', 'Нитро', 'Бустер', 'Гонщик', 'Тайфун', 'Вихрь', 'Скорпион'];

// ---------------------------------------------------------------- three: основа
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1220);
const camera = new THREE.PerspectiveCamera(62, 2, 0.5, 3600);

// отражения на кузове: готовим один раз
let envTex = null;
try {
  const pm = new THREE.PMREMGenerator(renderer);
  envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.55;
} catch {
  /* без отражений тоже играбельно */
}

const hemi = new THREE.HemisphereLight(0xffffff, 0x666688, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera;
sc.left = -32; sc.right = 32; sc.top = 32; sc.bottom = -32; sc.near = 1; sc.far = 140;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.06;
sun.position.set(-30, 60, 25);
scene.add(sun);
scene.add(sun.target);

function updateParticleScale() {
  const sc2 = (window.innerHeight * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
  fxAdd.mat.uniforms.uScale.value = sc2;
  fxMix.mat.uniforms.uScale.value = sc2;
}
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  updateParticleScale();
}
function canvasTex(w, h, draw, repeat, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
  }
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------- лава (две движущиеся плёнки)
function lavaTexture(base, blob1, blob2, count) {
  return canvasTex(256, 256, (g, s) => {
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < count; i++) {
      const x = Math.random() * s;
      const y = Math.random() * s;
      const r = 10 + Math.random() * 30;
      for (const [ox, oy] of [[0, 0], [s, 0], [-s, 0], [0, s], [0, -s]]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, Math.random() < 0.5 ? blob1 : blob2);
        gr.addColorStop(1, 'rgba(255,90,0,0)');
        g.fillStyle = gr;
        g.beginPath();
        g.arc(x + ox, y + oy, r, 0, TAU);
        g.fill();
      }
    }
  }, 190);
}
const lavaTexA = lavaTexture('#c42a06', 'rgba(255,205,70,.95)', 'rgba(255,120,20,.85)', 80);
const lavaTexB = lavaTexture('#000000', 'rgba(255,170,40,.9)', 'rgba(255,60,0,.8)', 40);
lavaTexB.repeat.set(100, 100);
const lavaA = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshBasicMaterial({ map: lavaTexA, toneMapped: false }));
lavaA.rotation.x = -Math.PI / 2;
lavaA.position.y = LAVA_Y;
scene.add(lavaA);
const lavaB = new THREE.Mesh(
  new THREE.PlaneGeometry(6000, 6000),
  new THREE.MeshBasicMaterial({ map: lavaTexB, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
);
lavaB.rotation.x = -Math.PI / 2;
lavaB.position.y = LAVA_Y + 0.05;
scene.add(lavaB);

// ---------------------------------------------------------------- частицы
const P_VERT = `
attribute vec4 pcolor; attribute float psize; uniform float uScale; varying vec4 vC;
void main(){ vC = pcolor; vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = psize * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; }`;
const P_FRAG = `
varying vec4 vC;
void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d) * vC.a;
  if (a < 0.01) discard; gl_FragColor = vec4(vC.rgb, a); }`;

class Particles {
  constructor(max, additive) {
    this.n = max;
    this.i = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: P_VERT,
      fragmentShader: P_FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Points(g, this.mat);
    this.mesh.frustumCulled = false;
    this.geo = g;
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav = 0) {
    const i = this.i;
    this.i = (i + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a; this.grav[i] = grav;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a;
    this.size[i] = s0;
  }

  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      const k = 1 - this.life[i] / this.maxLife[i];
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      this.col[i * 4 + 3] = this.a0[i] * (1 - k) * (1 - k * 0.3);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.pcolor.needsUpdate = true;
    this.geo.attributes.psize.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.size.fill(0);
    this.col.fill(0);
  }
}
const fxAdd = new Particles(900, true); // искры, огонь, угли
const fxMix = new Particles(700, false); // пыль, дым
scene.add(fxAdd.mesh);
scene.add(fxMix.mesh);

function burst(x, y, z, n, kind) {
  for (let i = 0; i < n; i++) {
    const a = rnd(0, TAU);
    const e = rnd(-0.2, 1);
    const sp = rnd(3, 12);
    const vx = Math.cos(a) * sp;
    const vz = Math.sin(a) * sp;
    if (kind === 'spark') fxAdd.emit(x, y, z, vx, rnd(2, 9), vz, rnd(0.25, 0.5), 0.35, 0.05, 1, rnd(0.7, 0.95), 0.35, 1, 22);
    else if (kind === 'fire') fxAdd.emit(x, y + 0.5, z, vx * 0.7, e * 8 + 2, vz * 0.7, rnd(0.4, 0.8), rnd(1.6, 2.6), 0.3, 1, rnd(0.35, 0.65), 0.1, 1, 4);
    else if (kind === 'smoke') fxMix.emit(x, y + 0.5, z, vx * 0.35, rnd(2, 6), vz * 0.35, rnd(0.9, 1.6), 1.6, 4.5, 0.12, 0.12, 0.13, 0.7, -1);
    else if (kind === 'splash') fxAdd.emit(x, y, z, vx * 0.6, rnd(6, 14), vz * 0.6, rnd(0.6, 1.0), rnd(0.8, 1.6), 0.2, 1, rnd(0.45, 0.7), 0.1, 1, 24);
  }
}

// ---------------------------------------------------------------- небо
let sky = null;
function buildSky(theme) {
  if (sky) {
    scene.remove(sky);
    sky.geometry.dispose();
    sky.material.map.dispose();
    sky.material.dispose();
  }
  const tex = canvasTex(1024, 512, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, theme.sky[0]);
    gr.addColorStop(0.28, theme.sky[1]);
    gr.addColorStop(0.5, theme.sky[2]);
    gr.addColorStop(0.62, theme.sky[3]);
    gr.addColorStop(1, theme.sky[3]);
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    const glow = (x, y, r, c0, c1) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, c0);
      rg.addColorStop(1, c1);
      g.fillStyle = rg;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    };
    if (theme.id === 'halloween') {
      for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(255,255,255,${rnd(0.3, 0.9)})`; g.fillRect(rnd(0, w), rnd(0, h * 0.4), 2, 2); }
      glow(w * 0.3, h * 0.2, 150, 'rgba(255,230,160,.5)', 'rgba(255,230,160,0)');
      g.fillStyle = '#fff1b8';
      g.beginPath(); g.arc(w * 0.3, h * 0.2, 46, 0, TAU); g.fill();
      g.fillStyle = 'rgba(210,180,110,.5)';
      for (const [dx, dy, r] of [[-14, -8, 9], [12, 10, 12], [-6, 18, 6]]) { g.beginPath(); g.arc(w * 0.3 + dx, h * 0.2 + dy, r, 0, TAU); g.fill(); }
      g.fillStyle = '#12081f';
      for (let i = 0; i < 14; i++) { const x = rnd(0, w); const y = rnd(h * 0.12, h * 0.42); g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 10, y - 12, x + 22, y); g.quadraticCurveTo(x + 11, y - 4, x, y); g.fill(); }
    } else if (theme.id === 'christmas') {
      for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(255,255,255,${rnd(0.3, 0.8)})`; g.fillRect(rnd(0, w), rnd(0, h * 0.25), 2, 2); }
      const au = g.createLinearGradient(0, h * 0.15, 0, h * 0.4);
      au.addColorStop(0, 'rgba(120,255,190,0)'); au.addColorStop(0.5, 'rgba(120,255,190,.22)'); au.addColorStop(1, 'rgba(120,255,190,0)');
      g.fillStyle = au; g.fillRect(0, h * 0.15, w, h * 0.25);
    } else if (theme.id === 'desert') {
      glow(w * 0.62, h * 0.3, 190, 'rgba(255,250,210,.95)', 'rgba(255,240,190,0)');
      g.fillStyle = '#fffbe6';
      g.beginPath(); g.arc(w * 0.62, h * 0.3, 34, 0, TAU); g.fill();
      g.fillStyle = 'rgba(205,150,80,.55)';
      g.beginPath(); g.moveTo(0, h * 0.5);
      for (let x = 0; x <= w; x += 32) g.lineTo(x, h * 0.5 - 10 - Math.abs(Math.sin(x * 0.011)) * 26);
      g.lineTo(w, h * 0.5); g.fill();
    } else {
      for (let i = 0; i < 38; i++) {
        const x = rnd(0, w); const y = rnd(h * 0.18, h * 0.5); const r = rnd(30, 90);
        glow(x, y, r, 'rgba(255,255,255,.8)', 'rgba(255,255,255,0)');
        glow(x + r * 0.6, y + 6, r * 0.8, 'rgba(255,255,255,.7)', 'rgba(255,255,255,0)');
      }
    }
  }, 0);
  sky = new THREE.Mesh(
    new THREE.SphereGeometry(2400, 32, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false }),
  );
  sky.renderOrder = -10;
  scene.add(sky);
  scene.fog = new THREE.Fog(new THREE.Color(theme.fog), 650, 2300);
  scene.background = new THREE.Color(theme.fog);
}

// ---------------------------------------------------------------- сборка арены
let root = null;
let ramp = null;
let snow = null;
let floorMesh = null;
let rimRing = null;
let rimTube = null;
const padViews = [];

function disposeRoot() {
  if (!root) return;
  scene.remove(root);
  root.traverse((o) => {
    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k of ['map', 'roughnessMap', 'metalnessMap']) {
        const t = m[k];
        if (t && t !== softTex && typeof t.dispose === 'function') t.dispose();
      }
      if (m.dispose) m.dispose();
    }
  });
  root = null;
  ramp = null;
  snow = null;
  floorMesh = null;
  rimRing = null;
  rimTube = null;
  padViews.length = 0;
}

const std = (color, rough = 0.7, metal = 0.05, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra });

function floorTile(theme) {
  return canvasTex(256, 256, (g, s) => {
    const R = (a, b) => a + Math.random() * (b - a);
    const wrap = (x, y, fn) => { for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) fn(x + ox, y + oy); };
    const blob = (x, y, r, c0, c1) => wrap(x, y, (X, Y) => { const gr = g.createRadialGradient(X, Y, 0, X, Y, r); gr.addColorStop(0, c0); gr.addColorStop(1, c1); g.fillStyle = gr; g.beginPath(); g.arc(X, Y, r, 0, TAU); g.fill(); });
    if (theme.id === 'halloween') {
      g.fillStyle = '#3f2c5c'; g.fillRect(0, 0, s, s);
      g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(0, 0, s / 2, s / 2); g.fillRect(s / 2, s / 2, s / 2, s / 2);
      g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(s / 2, 0, s / 2, s / 2); g.fillRect(0, s / 2, s / 2, s / 2);
      g.strokeStyle = 'rgba(255,150,40,.4)'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, s - 3, s - 3);
      g.fillStyle = 'rgba(0,0,0,.25)';
      for (let i = 0; i < 40; i++) g.fillRect(R(0, s), R(0, s), R(1, 4), R(1, 4));
    } else if (theme.id === 'christmas') {
      g.fillStyle = '#eaf3ff'; g.fillRect(0, 0, s, s);
      for (let i = 0; i < 14; i++) blob(R(0, s), R(0, s), R(25, 60), 'rgba(170,200,240,.45)', 'rgba(170,200,240,0)');
      g.fillStyle = 'rgba(255,255,255,.95)';
      for (let i = 0; i < 60; i++) g.fillRect(R(0, s), R(0, s), 2, 2);
    } else if (theme.id === 'desert') {
      g.fillStyle = '#e3b96e'; g.fillRect(0, 0, s, s);
      for (let i = 0; i < 9; i++) { const y = R(0, s); g.strokeStyle = `rgba(${R(160, 200) | 0},${R(110, 145) | 0},60,.4)`; g.lineWidth = R(2, 5); g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(s * 0.3, y - 12, s * 0.7, y + 12, s, y); g.stroke(); }
      for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(${R(120, 170) | 0},${R(80, 120) | 0},40,${R(0.15, 0.4)})`; g.fillRect(R(0, s), R(0, s), 2, 2); }
    } else {
      g.fillStyle = '#d3eaff'; g.fillRect(0, 0, s, s);
      for (let i = 0; i < 18; i++) blob(R(0, s), R(0, s), R(30, 70), 'rgba(255,255,255,.95)', 'rgba(255,255,255,0)');
      for (let i = 0; i < 8; i++) blob(R(0, s), R(0, s), R(25, 50), 'rgba(110,170,235,.25)', 'rgba(110,170,235,0)');
    }
  }, 42);
}

// светящаяся разметка поля, как на футбольном поле в Rocket League
function floorMarks(theme) {
  const col = '#' + theme.rim.toString(16).padStart(6, '0');
  return canvasTex(1024, 1024, (g, s) => {
    g.clearRect(0, 0, s, s);
    const c = s / 2;
    g.strokeStyle = col;
    g.shadowColor = col;
    g.shadowBlur = 16;
    g.lineCap = 'round';
    const ring = (r, w, a) => { g.globalAlpha = a; g.lineWidth = w; g.beginPath(); g.arc(c, c, s * r, 0, TAU); g.stroke(); };
    ring(0.485, 12, 0.95);
    ring(0.33, 6, 0.6);
    ring(0.17, 6, 0.6);
    ring(0.045, 10, 0.9);
    g.globalAlpha = 0.4;
    g.lineWidth = 5;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + Math.PI / 8;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * s * 0.06, c + Math.sin(a) * s * 0.06);
      g.lineTo(c + Math.cos(a) * s * 0.47, c + Math.sin(a) * s * 0.47);
      g.stroke();
    }
    // пунктир там, где стоят платформы
    g.setLineDash([14, 18]);
    for (const r of [36, 88, 140, 192]) ring((r / R_FLAT) * 0.5, 4, 0.5);
    g.setLineDash([]);
  }, 0);
}

// стадион вокруг арены: трибуны с публикой, неоновые кольца, прожекторы
function buildStadium(theme, parent) {
  const rb = R_TOP + 30;
  const rt = R_TOP + 150;
  const top = 90;
  const pal = {
    halloween: ['#ff8a1f', '#9b5de5', '#ffd23f', '#3a2350', '#ffffff'],
    christmas: ['#d8262f', '#ffffff', '#1f8a4c', '#ffd23f', '#38bdf8'],
    desert: ['#ffd23f', '#ff8a1f', '#f4f0e6', '#c0662b', '#3b82f6'],
    sky: ['#ffffff', '#7dd3fc', '#fbbf24', '#ec4899', '#a78bfa'],
  }[theme.id];
  const crowd = canvasTex(1024, 512, (g, w, h) => {
    g.fillStyle = '#0d1020';
    g.fillRect(0, 0, w, h);
    for (let y = 4; y < h; y += 14) {
      for (let x = (y / 14) % 2 ? 6 : 0; x < w; x += 12) {
        g.globalAlpha = 0.5 + Math.random() * 0.5;
        g.fillStyle = pal[(Math.random() * pal.length) | 0];
        g.fillRect(x, y, 8, 9);
      }
    }
    g.globalAlpha = 1;
  }, 0);
  crowd.wrapS = THREE.RepeatWrapping;
  crowd.repeat.set(40, 1);
  const bowl = new THREE.Mesh(
    new THREE.CylinderGeometry(rt, rb, top + 3, 96, 1, true),
    new THREE.MeshBasicMaterial({ map: crowd, side: THREE.DoubleSide, color: 0xd0d0d0 }),
  );
  bowl.position.y = (top - 3) / 2;
  parent.add(bowl);

  const panels = canvasTex(1024, 128, (g, w, h) => {
    g.fillStyle = '#0b0e1a';
    g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 32) { g.fillStyle = Math.random() < 0.6 ? 'rgba(255,240,200,.85)' : 'rgba(120,160,255,.5)'; g.fillRect(x + 4, 18, 24, 34); g.fillRect(x + 4, 70, 24, 34); }
  }, 0);
  panels.wrapS = THREE.RepeatWrapping;
  panels.repeat.set(48, 1);
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(rt, rt, 26, 96, 1, true),
    new THREE.MeshBasicMaterial({ map: panels, side: THREE.DoubleSide, toneMapped: false }),
  );
  wall.position.y = top + 13;
  parent.add(wall);

  const neon = new THREE.MeshBasicMaterial({ color: theme.rim, toneMapped: false });
  for (const [r, y, t] of [[rt, top, 1.6], [rt, top + 26, 1.2], [rb, -2.6, 1.4]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 160), neon);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = y;
    parent.add(ring);
  }

  // прожекторы: башня, лампа и широкий луч к центру арены
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff1cf, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc, toneMapped: false });
  const poleMat = std(0x20243a, 0.6, 0.5);
  const TOWERS = 16;
  for (let i = 0; i < TOWERS; i++) {
    const a = (i / TOWERS) * TAU + 0.2;
    const x = Math.cos(a) * (rt - 8);
    const z = Math.sin(a) * (rt - 8);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.6, top + 32, 8), poleMat);
    pole.position.set(x, (top + 32) / 2 - 3, z);
    parent.add(pole);
    const hy = top + 30;
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(14, 7, 4), lampMat);
    lamp.position.set(x, hy, z);
    lamp.lookAt(0, 0, 0);
    parent.add(lamp);
    const len = Math.hypot(x, hy, z);
    const geo = new THREE.CylinderGeometry(38, 1.2, len, 18, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, len / 2);
    const beam = new THREE.Mesh(geo, beamMat);
    beam.position.set(x, hy, z);
    beam.lookAt(0, 0, 0);
    parent.add(beam);
  }
}

const RAMP_N = 128;
function buildRamp(c1, c2) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(RAMP_N * 4 * 3);
  const col = new Float32Array(RAMP_N * 4 * 3);
  const idx = [];
  const a = new THREE.Color(c1);
  const b = new THREE.Color(c2);
  for (let i = 0; i < RAMP_N; i++) {
    const c = i % 2 ? b : a;
    for (let k = 0; k < 4; k++) col.set([c.r, c.g, c.b], (i * 4 + k) * 3);
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  updateRamp(g, R_FLAT, R_TOP);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide }));
  m.frustumCulled = false;
  m.receiveShadow = true;
  return m;
}
function updateRamp(g, rIn, rOut) {
  const p = g.attributes.position.array;
  for (let i = 0; i < RAMP_N; i++) {
    const a0 = (i / RAMP_N) * TAU;
    const a1 = ((i + 1) / RAMP_N) * TAU;
    const c0 = Math.cos(a0); const s0 = Math.sin(a0);
    const c1 = Math.cos(a1); const s1 = Math.sin(a1);
    p.set([c0 * rIn, 0.02, s0 * rIn, c0 * rOut, WALL_H, s0 * rOut, c1 * rIn, 0.02, s1 * rIn, c1 * rOut, WALL_H, s1 * rOut], i * 12);
  }
  g.attributes.position.needsUpdate = true;
  g.computeVertexNormals();
}

function padIcons() {
  const g = new THREE.Group();
  const mk = (geo, color) => {
    const m = new THREE.Mesh(geo, std(color, 0.35, 0.3, { emissive: color, emissiveIntensity: 0.6 }));
    m.visible = false;
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const icons = {
    shield: mk(new THREE.SphereGeometry(0.85, 16, 12), PAD_COLOR.shield),
    missile: mk(new THREE.ConeGeometry(0.5, 1.8, 12), PAD_COLOR.missile),
    blast: mk(new THREE.TorusGeometry(0.7, 0.28, 10, 20), PAD_COLOR.blast),
    bow: mk(new THREE.TorusGeometry(0.8, 0.15, 8, 20, Math.PI), PAD_COLOR.bow),
    glove: mk(new THREE.BoxGeometry(1.05, 1.05, 1.05), PAD_COLOR.glove),
  };
  icons.blast.rotation.x = Math.PI / 2;
  return { g, icons };
}

// склеивает множество мелких объектов с одинаковым материалом в один (десятки тысяч вызовов отрисовки -> единицы)
function flatten(group, parent) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    const key = [m.type, m.color ? m.color.getHex() : 0, m.emissive ? m.emissive.getHex() : 0, m.roughness, m.metalness, m.emissiveIntensity].join('|');
    let b = buckets.get(key);
    if (!b) { b = { mat: m, geos: [] }; buckets.set(key, b); }
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    b.geos.push(g);
  });
  for (const b of buckets.values()) {
    const nonIdx = b.geos.some((g) => !g.index);
    const geos = b.geos.map((g0) => {
      let g = g0;
      if (nonIdx && g.index) g = g.toNonIndexed();
      for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
      return g;
    });
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, b.mat);
    mesh.frustumCulled = false;
    parent.add(mesh);
  }
}

function decorate(theme, parent) {
  const N = 96;
  const tmpRoot = new THREE.Group();
  const pillarMat = std(theme.id === 'sky' ? 0xdfeaf7 : 0x2a2d44, 0.8, 0.1);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU + 0.1;
    const r = R_TOP + 2.6;
    const g = new THREE.Group();
    // колонна от лавы до верхнего края
    const pil = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.1, WALL_H - LAVA_Y + 2, 8), pillarMat);
    pil.position.y = (WALL_H + LAVA_Y) / 2 - 1;
    g.add(pil);
    const top = new THREE.Group();
    top.position.y = WALL_H + 0.8;
    top.scale.setScalar(3.0);
    g.add(top);
    if (theme.id === 'halloween') {
      if (i % 2 === 0) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(1.9, 14, 10), std(0xff7a14, 0.5, 0.05, { emissive: 0xff5a00, emissiveIntensity: 0.5 }));
        p.scale.y = 0.8; p.position.y = 1.4; top.add(p);
        const st = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.32, 0.9, 6), std(0x2f7d32));
        st.position.y = 2.9; top.add(st);
        const eyeM = new THREE.MeshBasicMaterial({ color: 0xffe36b, toneMapped: false });
        for (const sx of [-0.6, 0.6]) { const e = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.6, 3), eyeM); e.position.set(sx, 1.8, 1.65); e.rotation.x = Math.PI / 2; top.add(e); }
        const mouth = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.28, 0.2), eyeM);
        mouth.position.set(0, 0.95, 1.7); top.add(mouth);
        g.rotation.y = -a + Math.PI / 2;
      } else {
        const t = new THREE.Mesh(new THREE.ConeGeometry(1.6, 6, 7), std(0x2a1f3d, 0.9));
        t.position.y = 3; top.add(t);
        const t2 = new THREE.Mesh(new THREE.ConeGeometry(1.1, 4, 7), std(0x3b2c55, 0.9));
        t2.position.y = 6; top.add(t2);
        const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: 0x9dff6b, toneMapped: false }));
        lantern.position.set(1.0, 1.4, 0); top.add(lantern);
      }
    } else if (theme.id === 'christmas') {
      if (i % 2 === 0) {
        const cols = [0xd8262f, 0xffd23f, 0x38bdf8];
        for (let k = 0; k < 3; k++) {
          const c = new THREE.Mesh(new THREE.ConeGeometry(2.6 - k * 0.6, 2.8, 10), std(0x1f8a4c, 0.8));
          c.position.y = 1.9 + k * 1.7; top.add(c);
          const ball = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), new THREE.MeshBasicMaterial({ color: cols[(k + i) % 3], toneMapped: false }));
          ball.position.set(1.3 - k * 0.4, 1.2 + k * 1.7, 1.0); top.add(ball);
        }
        const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), new THREE.MeshBasicMaterial({ color: 0xffe36b, toneMapped: false }));
        star.position.y = 7.3; top.add(star);
      } else {
        const box = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.2, 2.4), std(i % 4 === 1 ? 0xd8262f : 0x2f6fd8, 0.4, 0.2));
        box.position.y = 1.1; top.add(box);
        const rb = new THREE.Mesh(new THREE.BoxGeometry(2.45, 2.25, 0.5), std(0xffd23f, 0.3, 0.5));
        rb.position.y = 1.1; top.add(rb);
        const rb2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.25, 2.45), std(0xffd23f, 0.3, 0.5));
        rb2.position.y = 1.1; top.add(rb2);
      }
    } else if (theme.id === 'desert') {
      if (i % 2 === 0) {
        const m = std(0x2f9e44, 0.8);
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 5, 10), m);
        body.position.y = 2.5; top.add(body);
        for (const s of [-1, 1]) {
          const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 2, 8), m);
          arm.position.set(s * 1.3, 3.2, 0); top.add(arm);
          const lnk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.3, 8), m);
          lnk.rotation.z = Math.PI / 2; lnk.position.set(s * 0.7, 2.3, 0); top.add(lnk);
        }
      } else {
        const r = new THREE.Mesh(new THREE.DodecahedronGeometry(1.8), std(0xa8743c, 0.95));
        r.position.y = 1.2; r.scale.y = 0.7; top.add(r);
      }
    } else {
      const m = std(0xffffff, 0.95);
      for (const [x, y, z, s] of [[0, 1.6, 0, 2.2], [1.8, 1.1, 0.3, 1.7], [-1.7, 1.1, -0.2, 1.8], [0.3, 2.7, 0.2, 1.7]]) {
        const p = new THREE.Mesh(new THREE.SphereGeometry(s, 12, 9), m);
        p.position.set(x, y, z); top.add(p);
      }
    }
    g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    tmpRoot.add(g);
  }
  if (theme.id === 'christmas') {
    const cols = [0xff4d4d, 0xffd23f, 0x4ade80, 0x38bdf8];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * TAU;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), new THREE.MeshBasicMaterial({ color: cols[i % 4], toneMapped: false }));
      bulb.position.set(Math.cos(a) * (R_TOP + 0.5), WALL_H + 0.5, Math.sin(a) * (R_TOP + 0.5));
      tmpRoot.add(bulb);
    }
  }
  flatten(tmpRoot, parent);
}

function buildArena(theme) {
  disposeRoot();
  root = new THREE.Group();
  scene.add(root);
  buildSky(theme);

  floorMesh = new THREE.Group();
  const floorBase = new THREE.Mesh(new THREE.CircleGeometry(R_FLAT, 128), std(0xffffff, 0.85, 0.02, { map: floorTile(theme) }));
  floorBase.rotation.x = -Math.PI / 2;
  floorBase.receiveShadow = true;
  floorMesh.add(floorBase);
  const floorLines = new THREE.Mesh(
    new THREE.CircleGeometry(R_FLAT, 128),
    new THREE.MeshBasicMaterial({ map: floorMarks(theme), transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  floorLines.rotation.x = -Math.PI / 2;
  floorLines.position.y = 0.04;
  floorMesh.add(floorLines);
  root.add(floorMesh);

  ramp = buildRamp(theme.wall[0], theme.wall[1]);
  root.add(ramp);

  // светящиеся кромки: внизу стены и по верхнему краю
  rimRing = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 192), new THREE.MeshBasicMaterial({ color: theme.rim, side: THREE.DoubleSide, toneMapped: false }));
  rimRing.rotation.x = -Math.PI / 2;
  rimRing.position.y = 0.05;
  rimRing.scale.set(R_FLAT, R_FLAT, 1);
  root.add(rimRing);
  rimTube = new THREE.Mesh(new THREE.TorusGeometry(R_TOP, 0.4, 8, 192), new THREE.MeshBasicMaterial({ color: theme.rim, toneMapped: false }));
  rimTube.rotation.x = -Math.PI / 2;
  rimTube.position.y = WALL_H;
  root.add(rimTube);

  decorate(theme, root);
  buildStadium(theme, root);

  if (theme.snow) {
    const n = 260;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos.set([rnd(-55, 55), rnd(0, 45), rnd(-55, 55)], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    snow = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.9, map: softTex, transparent: true, opacity: 0.95, depthWrite: false }));
    snow.frustumCulled = false;
    root.add(snow);
  }

  hemi.color.set(theme.hemi[0]);
  hemi.groundColor.set(theme.hemi[1]);
  hemi.intensity = theme.hemi[2];
  sun.color.set(theme.sun[0]);
  sun.intensity = theme.sun[1];
}

// ---------------------------------------------------------------- кольца-ударные волны
const ringFx = [];
const ringGeo = new THREE.RingGeometry(0.85, 1, 40);
function ringBurst(x, z, color, size, dur, y = 0.4) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  const m = new THREE.Mesh(ringGeo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.scale.setScalar(0.3);
  scene.add(m);
  ringFx.push({ m, t: 0, dur, size });
}
function updateRings(dt) {
  for (let i = ringFx.length - 1; i >= 0; i--) {
    const f = ringFx[i];
    f.t += dt;
    const k = f.t / f.dur;
    if (k >= 1) {
      scene.remove(f.m);
      f.m.material.dispose();
      ringFx.splice(i, 1);
      continue;
    }
    f.m.scale.setScalar(0.3 + f.size * k);
    f.m.material.opacity = 0.9 * (1 - k);
  }
}
function clearRings() {
  for (const f of ringFx) { scene.remove(f.m); f.m.material.dispose(); }
  ringFx.length = 0;
}

// ---------------------------------------------------------------- вспышки света, купола, обломки, горящие остовы
const flashLights = [0, 1].map(() => {
  const l = new THREE.PointLight(0xffffff, 0, 90, 2);
  scene.add(l);
  return { l, t: 0, dur: 1, peak: 0 };
});
function flashLight(x, y, z, color, peak, dur) {
  const f = flashLights[0].t < flashLights[1].t ? flashLights[0] : flashLights[1];
  f.l.position.set(x, y, z);
  f.l.color.setHex(color);
  f.peak = peak;
  f.dur = dur;
  f.t = dur;
}
function updateFlashes(dt) {
  for (const f of flashLights) {
    if (f.t > 0) { f.t -= dt; f.l.intensity = f.peak * Math.max(0, f.t / f.dur) ** 2; } else f.l.intensity = 0;
  }
}
const domes = [];
const domeGeo = new THREE.SphereGeometry(1, 20, 12);
function domeBurst(x, y, z, color, size, dur) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const m = new THREE.Mesh(domeGeo, mat);
  m.position.set(x, y, z);
  m.scale.setScalar(0.4);
  scene.add(m);
  domes.push({ m, t: 0, dur, size });
}
function updateDomes(dt) {
  for (let i = domes.length - 1; i >= 0; i--) {
    const d = domes[i];
    d.t += dt;
    const k = d.t / d.dur;
    if (k >= 1) { scene.remove(d.m); d.m.material.dispose(); domes.splice(i, 1); continue; }
    d.m.scale.setScalar(0.4 + d.size * (1 - (1 - k) ** 3));
    d.m.material.opacity = 0.55 * (1 - k) ** 1.5;
  }
}
const debris = [];
const debGeo = new THREE.BoxGeometry(1, 1, 1);
const debMats = new Map();
function debMat(c) {
  if (!debMats.has(c)) debMats.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.6 }));
  return debMats.get(c);
}
function spawnDebris(x, y, z, color, n, power) {
  for (let i = 0; i < n; i++) {
    if (debris.length > 90) { const o = debris.shift(); scene.remove(o.m); }
    const m = new THREE.Mesh(debGeo, debMat(i % 3 === 0 ? 0x15171d : color));
    m.scale.set(rnd(0.25, 1.1), rnd(0.12, 0.5), rnd(0.25, 0.9));
    m.position.set(x + rnd(-1, 1), y + rnd(0.3, 1.2), z + rnd(-1, 1));
    m.castShadow = true;
    scene.add(m);
    const a = rnd(0, TAU);
    const s = rnd(0.3, 1) * power;
    debris.push({ m, vx: Math.cos(a) * s, vy: rnd(0.6, 1.2) * power * 0.8, vz: Math.sin(a) * s, rx: rnd(-8, 8), ry: rnd(-8, 8), rz: rnd(-8, 8), life: rnd(3, 5) });
  }
}
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life -= dt;
    if (d.life <= 0) { scene.remove(d.m); debris.splice(i, 1); continue; }
    d.vy -= 28 * dt;
    d.m.position.x += d.vx * dt;
    d.m.position.y += d.vy * dt;
    d.m.position.z += d.vz * dt;
    const r = Math.hypot(d.m.position.x, d.m.position.z);
    const gy = W ? groundH(r) + 0.15 : 0.15;
    if (d.m.position.y < gy && r < (W ? W.rTop : R_TOP)) {
      d.m.position.y = gy;
      d.vy = Math.abs(d.vy) * 0.35;
      d.vx *= 0.7; d.vz *= 0.7; d.rx *= 0.6; d.ry *= 0.6; d.rz *= 0.6;
      if (d.vy < 1) d.vy = 0;
    }
    d.m.rotation.x += d.rx * dt; d.m.rotation.y += d.ry * dt; d.m.rotation.z += d.rz * dt;
    if (d.life < 0.6) d.m.scale.multiplyScalar(1 - dt * 1.6);
  }
}
function clearDebris() {
  for (const d of debris) scene.remove(d.m);
  debris.length = 0;
  for (const d of domes) { scene.remove(d.m); d.m.material.dispose(); }
  domes.length = 0;
  burners.length = 0;
  for (const f of flashLights) { f.t = 0; f.l.intensity = 0; }
}
const burners = []; // горящие остовы разбитых машин
function updateBurners(dt) {
  for (let i = burners.length - 1; i >= 0; i--) {
    const b = burners[i];
    b.t -= dt;
    if (b.t <= 0) { burners.splice(i, 1); continue; }
    const k = Math.min(1, b.t / 2);
    if (Math.random() < 0.8 * k) fxAdd.emit(b.x + rnd(-1.2, 1.2), 0.6, b.z + rnd(-1, 1), rnd(-0.5, 0.5), rnd(3, 6), rnd(-0.5, 0.5), rnd(0.4, 0.8), 1.8, 0.2, 1, rnd(0.35, 0.6), 0.08, 0.9, 0);
    if (Math.random() < 0.7) fxMix.emit(b.x + rnd(-1, 1), 1.0, b.z + rnd(-1, 1), rnd(-0.6, 0.6), rnd(3, 5), rnd(-0.6, 0.6), rnd(1.2, 2.2), 1.5, 5, 0.1, 0.1, 0.11, 0.6 * k, -0.3);
  }
}

// ---------------------------------------------------------------- состояние матча
let mode = 'menu'; // menu | game
let W = null;
let carViews = [];
let shotViews = new Map();
let player = null;
let lastCount = 4;
let accum = 0;
let resultShown = false;
let curTheme = ARENAS[0];
let tagEls = [];
let chipEls = [];
let shake = 0;
let isOnline = false;
let excite = 0.3; // «накал» трибун: растёт от событий, затухает
let specId = -1;
let specMode = 0;
let specAutoT = 0;
const SPEC_MODES = ['auto', 'follow', 'free', 'top'];
const SPEC_NAMES = ['🎬 Авто', '🚗 За машиной', '🔄 Вокруг', '🛰 Сверху'];

// камера от третьего лица
const cam = { yaw: 0, x: 0, y: 10, z: 20, lx: 0, ly: 0, lz: 0, off: 0, orbit: 0, zoom: 1, drag: 0 };

const shotGeo = {
  missile: new THREE.ConeGeometry(0.55, 2.6, 10),
  arrow: new THREE.BoxGeometry(2.2, 0.16, 0.16),
};

function pickOpponentCars(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.max(0, Math.min(CARS.length - 1, S.car + Math.round((Math.random() - 0.5) * 6)));
    out.push(CARS[idx]);
  }
  return out;
}
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function groundH(r) {
  if (!W || r <= W.rFlat) return 0;
  return Math.min(1, (r - W.rFlat) / Math.max(0.1, W.rTop - W.rFlat)) * WALL_H;
}

// пространственный звук: громкость от расстояния до камеры, панорама слева/справа
const tmpV = new THREE.Vector3();
function spat(x, z) {
  const dx = x - camera.position.x;
  const dz = z - camera.position.z;
  const d = Math.hypot(dx, dz);
  camera.getWorldDirection(tmpV);
  const fl = Math.hypot(tmpV.x, tmpV.z) || 1;
  const fx = tmpV.x / fl;
  const fz = tmpV.z / fl;
  const pan = d > 0.5 ? ((dx * -fz + dz * fx) / d) * 0.9 : 0;
  return { v: Math.max(0.1, 1 / (1 + d / 60)), pan };
}
const near = (x, z, r) => player && Math.hypot(x - player.x, z - player.z) < r;
const boost = (v) => { excite = Math.min(1, excite + v); };

// ---------------------------------------------------------------- запуск матча
function beginMatch(entries, youId, themeIdx, padDefs, online) {
  curTheme = ARENAS[themeIdx] || ARENAS[0];
  buildArena(curTheme);
  clearRings();
  clearDebris();
  fxAdd.clear();
  fxMix.clear();
  shotViews.forEach((v) => root.remove(v));
  shotViews = new Map();

  W = createWorld(entries);
  if (padDefs) padDefs.forEach((d, i) => { const p = W.pads[i]; if (p) { p.a = d[0]; p.r0 = d[1]; p.x = Math.cos(d[0]) * d[1]; p.z = Math.sin(d[0]) * d[1]; p.type = null; } });
  W.playerId = youId;
  player = W.cars[youId];
  player.isPlayer = true;
  player.bot = null;
  isOnline = !!online;
  W.cars.forEach((c, i) => { if (online) c.bot = null; c.isPlayer = i === youId; });

  carViews = W.cars.map((c, i) => {
    const v = buildCar(c.def, c.isPlayer, CAR_COLORS[i]);
    v.trail = hexRgb(CAR_COLORS[i]);
    root.add(v.holder);
    return v;
  });

  // платформы со способностями
  W.pads.forEach(() => {
    const g = new THREE.Group();
    g.scale.setScalar(1.2);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.7, 0.35, 24), std(0x1d2238, 0.4, 0.7));
    base.position.y = 0.17;
    g.add(base);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, side: THREE.DoubleSide, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.85, 2.3, 28), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.37;
    g.add(ring);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 2.0, 26, 14, 1, true), beamMat);
    beam.position.y = 13;
    g.add(beam);
    const ic = padIcons();
    ic.g.position.y = 2.2;
    ic.g.scale.setScalar(1.25);
    g.add(ic.g);
    root.add(g);
    padViews.push({ g, ic, ring, ringMat, beam, beamMat });
  });

  // плашки здоровья над соперниками и чипы для наблюдения
  $('tags').innerHTML = '';
  tagEls = W.cars.map((c, i) => {
    if (c.isPlayer) return null;
    const d = document.createElement('div');
    d.className = 'tag';
    d.innerHTML = `<div style="color:${CAR_COLORS[i]}">${c.name}</div><div class="tb"><i style="background:${CAR_COLORS[i]};width:100%"></i></div>`;
    $('tags').appendChild(d);
    return { d, bar: d.querySelector('i') };
  });
  $('chips').innerHTML = '';
  chipEls = W.cars.map((c, i) => {
    if (c.isPlayer) return null;
    const d = document.createElement('button');
    d.className = 'chipb';
    d.dataset.id = i;
    d.innerHTML = `<span style="color:${CAR_COLORS[i]}">●</span> ${c.name}<div class="tb"><i style="background:${CAR_COLORS[i]}"></i></div>`;
    $('chips').appendChild(d);
    return { d, bar: d.querySelector('i') };
  });

  cam.yaw = player.h;
  cam.off = 0;
  cam.orbit = player.h;
  cam.zoom = 1;
  snapCamera(player);

  mode = 'game';
  accum = 0;
  resultShown = false;
  lastCount = 4;
  specId = -1;
  specMode = 0;
  shake = 0;
  excite = 0.3;
  rawX = 0; rawY = 0;
  show('hud');
  $('hud').className = 'screen on ' + (S.side === 'right' ? 'R' : 'L');
  $('abil').style.setProperty('--s', String(S.btn));
  $('jump').style.setProperty('--s', String(S.btn));
  $('spec').style.display = 'none';
  $('big').textContent = '';
  $('alive').textContent = '';
  $('drag').style.display = 'none';
  A.musicStop();
  A.crowd.start();
  A.engine.start();
  onResize();
}

function startOffline() {
  A.initAudio();
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  const opp = pickOpponentCars(3);
  const entries = [{ name: S.name, def: CARS[S.car], isPlayer: true }];
  opp.forEach((d, i) => entries.push({ name: names[i], def: d }));
  beginMatch(entries, 0, S.arena, null, false);
}

function startOnline(m) {
  const entries = m.cars.map((c) => ({ name: c.name, def: CARS[c.car] || CARS[0], isPlayer: false }));
  N.net.snaps.length = 0;
  beginMatch(entries, m.you, m.arena, m.pads, true);
}

function endToMenu() {
  mode = 'menu';
  W = null;
  player = null;
  isOnline = false;
  disposeRoot();
  clearRings();
  clearDebris();
  fxAdd.clear();
  fxMix.clear();
  shotViews = new Map();
  carViews = [];
  $('tags').innerHTML = '';
  A.engine.stop();
  A.crowd.stop();
  scene.background = new THREE.Color(0x0f1220);
  showMenu();
}

// ---------------------------------------------------------------- камера
const isSpec = () => !!(W && player && !player.alive);
function camTarget() {
  if (!player.alive || player.falling) {
    if (player.falling && player.alive) return player; // провожаем падение
    const live = W.cars.filter((c) => c.alive && !c.falling);
    if (!live.length) return W.winner || player;
    let t = live.find((c) => c.id === specId);
    if (!t || (SPEC_MODES[specMode] === 'auto' && specAutoT <= 0)) {
      if (SPEC_MODES[specMode] === 'auto' && live.length > 1) {
        // авто: следим за машиной, рядом с которой больше всего действия
        let best = live[0];
        let bd = 1e9;
        for (const a of live) for (const b of live) {
          if (a === b) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z) - (a.hp < 40 ? 15 : 0);
          if (d < bd) { bd = d; best = a; }
        }
        if (!t || (t !== best && bd < 40)) t = best;
        specAutoT = 3;
      } else if (!t) t = live[0];
      specId = t.id;
    }
    return t;
  }
  return player;
}

function desiredCam(t, dist, hgt) {
  const fx = Math.cos(cam.yaw);
  const fz = Math.sin(cam.yaw);
  let x = t.x - fx * dist;
  let z = t.z - fz * dist;
  const r = Math.hypot(x, z);
  const maxR = W.rTop + 3.5;
  if (r > maxR) { x = (x / r) * maxR; z = (z / r) * maxR; }
  const gh = groundH(Math.min(r, W.rTop + 1));
  const y = Math.max(t.y + hgt, gh + hgt * 0.78);
  return { x, y, z };
}
function snapCamera(t) {
  const d = desiredCam(t, 15.5, 6.9);
  cam.x = d.x; cam.y = d.y; cam.z = d.z;
  cam.lx = t.x + Math.cos(cam.yaw) * 6;
  cam.lz = t.z + Math.sin(cam.yaw) * 6;
  cam.ly = t.y + 1.2;
}

function updateCamera(dt) {
  const t = camTarget();
  const spec = isSpec();
  const m = spec ? SPEC_MODES[specMode] : 'chase';
  specAutoT -= dt;
  const sp = Math.hypot(t.vx, t.vz);
  let fov = 62 + Math.min(10, sp * 0.45);
  if (m === 'top') {
    // обзор сверху: вся арена, вращение пальцем
    const R = Math.max(60, W.rTop) * cam.zoom;
    const o = cam.orbit;
    const px = Math.sin(o) * R * 0.5;
    const pz = Math.cos(o) * R * 0.5;
    const py = R * 0.95;
    const k = 1 - Math.exp(-4 * dt);
    cam.x += (px - cam.x) * k; cam.y += (py - cam.y) * k; cam.z += (pz - cam.z) * k;
    cam.lx += (0 - cam.lx) * k; cam.ly += (0 - cam.ly) * k; cam.lz += (0 - cam.lz) * k;
    fov = 55;
    cam.yaw = o + Math.PI;
  } else {
    let dist = 15.5 + Math.min(3.5, sp * 0.11);
    let hgt = 6.9;
    if (m === 'free') {
      cam.yaw += angDiff(cam.yaw, cam.orbit) * (1 - Math.exp(-8 * dt));
      dist = 26 * cam.zoom; hgt = 12 * cam.zoom;
    } else {
      const follow = sp > 1.2 || t === player ? t.h : cam.yaw;
      const goal = follow + (spec ? cam.off : 0);
      cam.yaw += angDiff(cam.yaw, goal) * (1 - Math.exp(-3.4 * dt));
      if (spec) { dist = 19 * cam.zoom; hgt = 8.5 * cam.zoom; if (!cam.drag) cam.off *= Math.exp(-0.35 * dt); }
      cam.orbit = cam.yaw;
    }
    const d = desiredCam(t, dist, hgt);
    const k = 1 - Math.exp(-9 * dt);
    cam.x += (d.x - cam.x) * k; cam.y += (d.y - cam.y) * k; cam.z += (d.z - cam.z) * k;
    const lk = 1 - Math.exp(-12 * dt);
    cam.lx += (t.x + Math.cos(cam.yaw) * 6 - cam.lx) * lk;
    cam.lz += (t.z + Math.sin(cam.yaw) * 6 - cam.lz) * lk;
    cam.ly += (t.y + 1.3 - cam.ly) * lk;
  }
  shake = Math.max(0, shake - dt * 2.2);
  const sx = (Math.random() - 0.5) * shake;
  const sy = (Math.random() - 0.5) * shake;
  camera.position.set(cam.x + sx, cam.y + sy, cam.z + sx);
  camera.lookAt(cam.lx, cam.ly, cam.lz);
  if (Math.abs(fov - camera.fov) > 0.05) {
    camera.fov += (fov - camera.fov) * (1 - Math.exp(-4 * dt));
    camera.updateProjectionMatrix();
    updateParticleScale();
  }
  if (sky) sky.position.set(camera.position.x, 0, camera.position.z);
  sun.target.position.set(t.x, 0, t.z);
  sun.position.set(t.x - 30, 60, t.z + 25);
}

// ---------------------------------------------------------------- синхронизация вида с симуляцией
function syncViews(dt) {
  const t = performance.now() / 1000;
  const R0 = W.rFlat;
  const slope = Math.atan2(WALL_H, Math.max(0.1, W.rTop - W.rFlat));
  const dustCol = curTheme.dust;
  const camX = camera.position.x;
  const camZ = camera.position.z;

  W.cars.forEach((c, i) => {
    const v = carViews[i];
    v.holder.visible = c.alive;
    if (!c.alive) return;
    v.holder.position.set(c.x, c.y + 0.02, c.z);
    v.holder.rotation.y = -c.h;
    const sp = Math.hypot(c.vx, c.vz);
    const air = c.jy > 0.12;
    for (const w of v.wheels) w.rotation.z -= (sp / (c.def.body.wr * 1.3)) * dt * (Math.cos(Math.atan2(c.vz, c.vx) - c.h) >= 0 ? 1 : -1);

    if (c.falling) {
      v.body.rotation.z += dt * 4;
      v.body.rotation.x += dt * 2.4;
    } else {
      const r = Math.hypot(c.x, c.z);
      let tx = 0;
      let tz = 0;
      if (r > R0 && r > 0.1 && !air) {
        const nx = c.x / r;
        const nz = c.z / r;
        tz = slope * (Math.cos(c.h) * nx + Math.sin(c.h) * nz);
        tx = -slope * (-Math.sin(c.h) * nx + Math.cos(c.h) * nz);
      }
      // в прыжке нос чуть задирается и падает вниз к приземлению
      if (air) tz += Math.max(-0.25, Math.min(0.25, (c.jvy !== undefined ? c.jvy : 0) * -0.008)) + 0.1;
      v.tiltX += (tx - v.tiltX) * 0.25;
      v.tiltZ += (tz - v.tiltZ) * 0.25;
      v.body.rotation.x = v.tiltX;
      v.body.rotation.z = v.tiltZ;
    }
    v.shield.visible = c.shield;
    if (c.shield) {
      v.shieldMat.uniforms.uTime.value = t + i;
      v.shield.scale.setScalar(1 + Math.sin(t * 6 + i) * 0.04);
    }
    if (v.flash > 0) {
      v.flash = Math.max(0, v.flash - dt * 4);
      for (const m of [v.paint, v.paintSide]) { if (m && m.emissive) { m.emissive.setHex(0xffffff); m.emissiveIntensity = v.flash * 1.6; } }
    } else if (v.paint.emissiveIntensity !== 0) {
      v.paint.emissiveIntensity = 0;
      if (v.paintSide) v.paintSide.emissiveIntensity = 0;
    }

    if (!c.falling) {
      const dcam = Math.hypot(c.x - camX, c.z - camZ);
      if (dcam < 90) {
        if (sp > 5 && c.y < 0.5 && Math.random() < Math.min(1, sp / 12) * 0.9) {
          const bx = c.x - Math.cos(c.h) * 1.8;
          const bz = c.z - Math.sin(c.h) * 1.8;
          fxMix.emit(bx + rnd(-0.6, 0.6), 0.4, bz + rnd(-0.6, 0.6), -c.vx * 0.08 + rnd(-0.6, 0.6), rnd(0.4, 1.4), -c.vz * 0.08 + rnd(-0.6, 0.6), rnd(0.5, 0.9), 0.7, 2.4, dustCol[0], dustCol[1], dustCol[2], 0.32, 0);
        }
        // огненные выхлопы на разгоне и реактивный след в воздухе
        if (sp > 13) {
          const lx = -Math.sin(c.h);
          const lz = Math.cos(c.h);
          for (const side of [-1, 1]) {
            fxAdd.emit(c.x - Math.cos(c.h) * 2.3 + lx * side * 0.95, 0.55 + c.y, c.z - Math.sin(c.h) * 2.3 + lz * side * 0.95, -c.vx * 0.04, 0.1, -c.vz * 0.04, 0.5, 0.75, 0.08, v.trail[0], v.trail[1], v.trail[2], 0.9, 0);
          }
          if (sp > 20 && Math.random() < 0.5) fxAdd.emit(c.x - Math.cos(c.h) * 2.2, 0.5 + c.y, c.z - Math.sin(c.h) * 2.2, -c.vx * 0.1, rnd(0, 1), -c.vz * 0.1, 0.18, 0.8, 0.1, 1, 0.6, 0.15, 0.9, 0);
        }
        if (air && Math.random() < 0.8) fxAdd.emit(c.x + rnd(-0.5, 0.5), c.y + 0.2, c.z + rnd(-0.5, 0.5), 0, -1.5, 0, 0.35, 0.9, 0.1, 0.5, 0.8, 1, 0.8, 0);
      }
      const hpK = c.hp / MAX_HP;
      if (dcam < 140) {
        if (hpK < 0.4 && Math.random() < (0.4 - hpK) * 1.6) fxMix.emit(c.x + rnd(-0.5, 0.5), c.y + 1.4, c.z + rnd(-0.5, 0.5), rnd(-0.5, 0.5), rnd(2, 4), rnd(-0.5, 0.5), rnd(0.8, 1.3), 0.8, 3, 0.1, 0.1, 0.11, 0.65, -0.5);
        if (hpK < 0.2 && Math.random() < 0.5) fxAdd.emit(c.x + rnd(-0.5, 0.5), c.y + 1.3, c.z + rnd(-0.5, 0.5), rnd(-0.4, 0.4), rnd(2, 4.5), rnd(-0.4, 0.4), rnd(0.3, 0.55), 1.2, 0.2, 1, rnd(0.4, 0.6), 0.1, 0.9, 0);
      }
    }
  });

  // платформы: только близкие рисуются полностью (экономия на телефоне)
  W.pads.forEach((p, i) => {
    const m = padViews[i];
    if (!m) return;
    m.g.visible = !p.off;
    m.g.position.set(p.x, 0, p.z);
    for (const k in m.ic.icons) m.ic.icons[k].visible = p.type === k;
    m.ic.g.visible = !!p.type;
    m.ic.g.rotation.y = t * 2;
    m.ic.g.position.y = 2.2 + Math.sin(t * 3 + i) * 0.25;
    const col = p.type ? PAD_COLOR[p.type] : 0x4b5568;
    m.ringMat.color.setHex(col);
    m.beam.visible = !!p.type;
    if (p.type) {
      m.beamMat.color.setHex(col);
      if (Math.hypot(p.x - camX, p.z - camZ) < 70 && Math.random() < 0.25) fxAdd.emit(p.x + rnd(-2, 2), 0.5, p.z + rnd(-2, 2), 0, rnd(2, 5), 0, 1.0, 0.5, 0.1, ((col >> 16) & 255) / 255, ((col >> 8) & 255) / 255, (col & 255) / 255, 0.8, 0);
    }
  });

  lavaA.position.y = W.lavaY;
  lavaB.position.y = W.lavaY + 0.05;
  lavaA.position.x = lavaB.position.x = camera.position.x;
  lavaA.position.z = lavaB.position.z = camera.position.z;
  // текстура привязана к миру, а не к камере
  lavaTexA.offset.set(camera.position.x / 6000 * 190 + t * 0.018, -camera.position.z / 6000 * 190 + t * 0.012);
  lavaTexB.offset.set(camera.position.x / 6000 * 100 - t * 0.03, -camera.position.z / 6000 * 100 + t * 0.022);

  if (W.shrinking) {
    const s = W.rFlat / R_FLAT;
    floorMesh.scale.set(s, 1, s);
    rimRing.scale.set(W.rFlat, W.rFlat, 1);
    rimTube.scale.set(W.rTop / R_TOP, W.rTop / R_TOP, 1);
    updateRamp(ramp.geometry, W.rFlat, W.rTop);
  }

  const alive = new Set(W.shots);
  shotViews.forEach((v, s) => {
    if (!alive.has(s)) { root.remove(v); v.material.dispose(); shotViews.delete(s); }
  });
  for (const s of W.shots) {
    let v = shotViews.get(s);
    if (!v) {
      v = new THREE.Mesh(shotGeo[s.k], new THREE.MeshBasicMaterial({ color: s.k === 'missile' ? 0xff4a2a : 0xfff3b0, toneMapped: false }));
      root.add(v);
      shotViews.set(s, v);
    }
    v.position.set(s.x, 1.3, s.z);
    v.rotation.set(0, -s.h, s.k === 'missile' ? -Math.PI / 2 : 0);
    if (s.k === 'missile') {
      const bx = s.x - Math.cos(s.h) * 1.6;
      const bz = s.z - Math.sin(s.h) * 1.6;
      for (let k = 0; k < 2; k++) fxAdd.emit(bx + rnd(-0.2, 0.2), 1.3 + rnd(-0.2, 0.2), bz + rnd(-0.2, 0.2), rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), 0.4, 1.5, 0.2, 1, rnd(0.45, 0.7), 0.1, 0.95, 0);
      fxMix.emit(bx - Math.cos(s.h) * 0.6, 1.3, bz - Math.sin(s.h) * 0.6, rnd(-1, 1), rnd(0, 1), rnd(-1, 1), 1.1, 0.8, 3, 0.55, 0.55, 0.55, 0.4, 0);
    } else {
      fxAdd.emit(s.x, 1.3, s.z, 0, 0, 0, 0.22, 0.6, 0.1, 1, 0.95, 0.6, 0.7, 0);
      fxAdd.emit(s.x - Math.cos(s.h) * 1.2, 1.3, s.z - Math.sin(s.h) * 1.2, 0, 0, 0, 0.18, 0.4, 0.05, 1, 1, 0.8, 0.6, 0);
    }
  }
  // угли над лавой вокруг камеры
  if (Math.random() < 0.8) {
    const a = rnd(0, TAU);
    const r = rnd(8, 90);
    fxAdd.emit(camera.position.x + Math.cos(a) * r, W.lavaY + 0.2, camera.position.z + Math.sin(a) * r, rnd(-0.6, 0.6), rnd(2.5, 6), rnd(-0.6, 0.6), rnd(1.6, 2.8), 0.6, 0.1, 1, rnd(0.4, 0.65), 0.1, 0.9, -0.2);
  }
  if (snow) {
    const tg = camTarget();
    snow.position.set(tg.x, 0, tg.z);
    const p = snow.geometry.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      p[i + 1] -= dt * 4.5;
      p[i] += Math.sin(t * 0.9 + i) * dt * 0.9;
      if (p[i + 1] < -1) p[i + 1] = 45;
    }
    snow.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- события матча: эффекты + звук + реакция трибун
function handleEvents() {
  for (const e of W.events) {
    const sp = e.x !== undefined ? spat(e.x, e.z) : null;
    const car = e.id !== undefined ? carViews[e.id] : null;
    switch (e.t) {
      case 'bump':
        ringBurst(e.x, e.z, 0xffffff, 2 + e.p * 3, 0.25);
        burst(e.x, 1.0, e.z, 6 + ((e.p * 14) | 0), 'spark');
        A.sfx.bump(sp, e.p);
        if (e.p > 0.45) { flashLight(e.x, 3, e.z, 0xffe9b0, 120 * e.p, 0.18); boost(0.12); }
        if (e.p > 0.7) A.crowd.ooh();
        if (near(e.x, e.z, 8)) shake = Math.max(shake, 0.35 * e.p + 0.1);
        break;
      case 'hit': ringBurst(e.x, e.z, 0xffd23f, 3.5, 0.3); burst(e.x, 1.0, e.z, 10, 'spark'); A.sfx.hit(sp); break;
      case 'dmg':
        if (car) car.flash = 1;
        if (e.id === W.playerId) {
          const f = $('flash');
          f.classList.add('on');
          setTimeout(() => f.classList.remove('on'), 80);
          A.sfx.hurt();
          shake = Math.max(shake, 0.55);
        }
        break;
      case 'pickup':
        if (e.id === W.playerId) A.sfx.pickup();
        if (W.cars[e.id]) { const c = W.cars[e.id]; ringBurst(c.x, c.z, 0x7dd3fc, 5, 0.4); burst(c.x, 1.2, c.z, 14, 'spark'); }
        break;
      case 'launch': A.sfx.launch(sp); flashLight(e.x, 2, e.z, 0xffa050, 160, 0.25); burst(e.x, 1.2, e.z, 8, 'fire'); break;
      case 'blast':
        ringBurst(e.x, e.z, 0xff8a1f, 14, 0.5);
        domeBurst(e.x, 1.2, e.z, 0xff9a3a, 9, 0.5);
        burst(e.x, 0.8, e.z, 26, 'fire');
        burst(e.x, 0.8, e.z, 14, 'smoke');
        flashLight(e.x, 3, e.z, 0xff8a2a, 500, 0.45);
        A.sfx.blast(sp);
        boost(0.3);
        A.crowd.cheer(0.6);
        if (near(e.x, e.z, 30)) shake = Math.max(shake, 0.6);
        break;
      case 'glove': {
        const gx = e.x + Math.cos(e.h) * 4;
        const gz = e.z + Math.sin(e.h) * 4;
        ringBurst(gx, gz, 0xfacc15, 7, 0.3);
        domeBurst(gx, 1.2, gz, 0xfde047, 4, 0.3);
        burst(gx, 1, gz, 16, 'spark');
        flashLight(gx, 2.5, gz, 0xfde047, 260, 0.25);
        A.sfx.glove(sp);
        break;
      }
      case 'explosion':
        ringBurst(e.x, e.z, 0xff6a1a, 10, 0.5);
        domeBurst(e.x, 1.0, e.z, 0xff7a24, 7, 0.45);
        burst(e.x, 1.0, e.z, 34, 'fire');
        burst(e.x, 1.0, e.z, 18, 'smoke');
        burst(e.x, 1.0, e.z, 14, 'spark');
        flashLight(e.x, 3, e.z, 0xff9a40, 560, 0.5);
        A.sfx.explosion(sp, 1);
        boost(0.25);
        A.crowd.cheer(0.5);
        if (near(e.x, e.z, 40)) shake = Math.max(shake, 0.7);
        break;
      case 'wreck': {
        const c = W.cars[e.id];
        ringBurst(e.x, e.z, 0xffb02e, 16, 0.6);
        domeBurst(e.x, 1.0, e.z, 0xffa030, 12, 0.6);
        burst(e.x, 1.0, e.z, 50, 'fire');
        burst(e.x, 1.0, e.z, 34, 'smoke');
        burst(e.x, 1.0, e.z, 26, 'spark');
        spawnDebris(e.x, 1, e.z, c ? c.def.color : 0xcccccc, 22, 14);
        flashLight(e.x, 3, e.z, 0xffa040, 800, 0.7);
        burners.push({ x: e.x, z: e.z, t: 6 });
        A.sfx.wreck(sp);
        boost(0.5);
        A.crowd.cheer(1);
        A.crowd.applause(2.2, 0.8);
        if (near(e.x, e.z, 60)) shake = Math.max(shake, 1.0);
        break;
      }
      case 'shield': if (e.id === W.playerId) A.sfx.shield(); if (W.cars[e.id]) domeBurst(W.cars[e.id].x, 1.3, W.cars[e.id].z, 0x4cc9ff, 4, 0.4); break;
      case 'shieldBreak': ringBurst(e.x, e.z, 0x4cc9ff, 6, 0.35); domeBurst(e.x, 1.3, e.z, 0x4cc9ff, 5, 0.35); burst(e.x, 1.2, e.z, 16, 'spark'); A.sfx.shieldBreak(sp); break;
      case 'jump': A.sfx.jump(sp); burst(e.x, 0.3, e.z, 8, 'smoke'); ringBurst(e.x, e.z, 0xffffff, 3.5, 0.3, 0.15); break;
      case 'land':
        A.sfx.land(sp, e.p);
        burst(e.x, 0.3, e.z, 6 + ((e.p * 10) | 0), 'smoke');
        if (e.p > 0.5) { ringBurst(e.x, e.z, 0xffffff, 4 + e.p * 3, 0.3, 0.15); if (near(e.x, e.z, 10)) shake = Math.max(shake, 0.25 * e.p); }
        break;
      case 'fall':
        A.sfx.fall();
        A.crowd.gasp();
        boost(0.25);
        if (e.id === W.playerId) shake = Math.max(shake, 0.6);
        break;
      case 'splash': {
        const ly = W.lavaY;
        burst(e.x, ly + 0.3, e.z, 46, 'splash');
        burst(e.x, ly + 0.5, e.z, 16, 'smoke');
        ringBurst(e.x, e.z, 0xff7a1a, 12, 0.7, ly + 0.2);
        domeBurst(e.x, ly, e.z, 0xff6a10, 8, 0.6);
        flashLight(e.x, ly + 4, e.z, 0xff6a10, 600, 0.6);
        A.sfx.lavaSplash(sp);
        A.crowd.cheer(0.9);
        A.crowd.ooh();
        boost(0.35);
        break;
      }
      case 'shrink': A.crowd.ooh(); toast('🌋 Лава поднимается! Арена сужается'); break;
      case 'go': A.sfx.go(); A.crowd.cheer(0.8); $('big').textContent = 'ВПЕРЁД!'; setTimeout(() => { if ($('big').textContent === 'ВПЕРЁД!') $('big').textContent = ''; }, 700); break;
      case 'end': A.crowd.applause(5, 1.4); A.crowd.cheer(1); break;
      default: break;
    }
  }
  W.events.length = 0;
}

// ---------------------------------------------------------------- HUD
const hpColor = (k) => (k > 0.6 ? '#4ade80' : k > 0.3 ? '#facc15' : '#ef4444');
const radar = $('radar');
const rctx = radar.getContext('2d');
function drawRadar() {
  const s = radar.width;
  const c = s / 2;
  const k = (c - 12) / (R_TOP + 2);
  rctx.clearRect(0, 0, s, s);
  rctx.fillStyle = 'rgba(12,16,34,.72)';
  rctx.beginPath(); rctx.arc(c, c, c - 2, 0, TAU); rctx.fill();
  const fx = Math.cos(cam.yaw);
  const fz = Math.sin(cam.yaw);
  const P = (x, z) => [c + (-fz * x + fx * z) * k, c - (fx * x + fz * z) * k];
  rctx.strokeStyle = 'rgba(255,255,255,.25)';
  rctx.lineWidth = 2;
  rctx.beginPath(); rctx.arc(c, c, W.rFlat * k, 0, TAU); rctx.stroke();
  rctx.strokeStyle = 'rgba(255,120,40,.7)';
  rctx.beginPath(); rctx.arc(c, c, W.rTop * k, 0, TAU); rctx.stroke();
  for (const p of W.pads) {
    if (p.off) continue;
    const [x, y] = P(p.x, p.z);
    rctx.fillStyle = p.type ? '#' + PAD_COLOR[p.type].toString(16).padStart(6, '0') : '#4b5568';
    rctx.fillRect(x - 3, y - 3, 6, 6);
  }
  W.cars.forEach((car, i) => {
    if (!car.alive || car.falling) return;
    const [x, y] = P(car.x, car.z);
    rctx.fillStyle = CAR_COLORS[i];
    rctx.beginPath(); rctx.arc(x, y, car.isPlayer ? 9 : 7, 0, TAU); rctx.fill();
    if (car.isPlayer) {
      const a = car.h - cam.yaw;
      rctx.strokeStyle = '#fff';
      rctx.lineWidth = 3;
      rctx.beginPath(); rctx.moveTo(x, y); rctx.lineTo(x + Math.sin(a) * 18, y - Math.cos(a) * 18); rctx.stroke();
    }
  });
}

function updateTags() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  W.cars.forEach((c, i) => {
    const el = tagEls[i];
    if (!el) return;
    if (!c.alive || c.falling) { el.d.style.display = 'none'; return; }
    tmpV.set(c.x, c.y + 4.2, c.z).project(camera);
    const dist = Math.hypot(c.x - camera.position.x, c.z - camera.position.z);
    if (tmpV.z > 1 || Math.abs(tmpV.x) > 1.15 || Math.abs(tmpV.y) > 1.15 || dist > 320) { el.d.style.display = 'none'; return; }
    el.d.style.display = 'block';
    const sc = Math.max(0.6, Math.min(1.15, 34 / dist));
    el.d.style.transform = `translate(${((tmpV.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-tmpV.y * 0.5 + 0.5) * h).toFixed(1)}px) scale(${sc.toFixed(2)})`;
    const k = c.hp / MAX_HP;
    el.bar.style.width = (k * 100).toFixed(0) + '%';
    el.bar.style.background = hpColor(k);
  });
}

function updateHud(dt) {
  if (W.state === 'countdown') {
    const n = Math.ceil(W.countdown);
    if (n !== lastCount && n > 0) { lastCount = n; A.sfx.tick(); }
    $('big').textContent = n > 0 ? String(n) : '';
  }
  const left = W.cars.filter((c) => c.alive && !c.falling).length;
  $('alive').textContent = `🚗 Живых: ${left}`;
  const ab = $('abil');
  ab.textContent = player.ability ? ICON[player.ability] : '';
  ab.classList.toggle('has', !!player.ability);
  // прыжок: кольцо перезарядки
  const jp = 1 - Math.min(1, player.jumpCd / JUMP_CD);
  const jb = $('jump');
  jb.style.setProperty('--p', (jp * 360).toFixed(0) + 'deg');
  jb.classList.toggle('rdy', jp >= 1);

  const hp = Math.max(0, Math.ceil(player.hp));
  const k = hp / MAX_HP;
  $('hpTxt').innerHTML = `<span>❤ Здоровье</span><b>${hp}</b>`;
  $('hpFill').style.width = (k * 100).toFixed(0) + '%';
  $('hpFill').style.background = hpColor(k);

  updateTags();
  drawRadar();

  // наблюдение
  const out = !player.alive;
  if (out && W.state !== 'ended') {
    $('spec').style.display = 'flex';
    $('hud').classList.add('spec');
    $('specTxt').textContent = player.wrecked ? '💥 Машина разбита — наблюдайте за боем' : '🌋 Вы в лаве — наблюдайте за боем';
    $('specMode').textContent = SPEC_NAMES[specMode];
    const tgt = W.cars[specId];
    chipEls.forEach((el, i) => {
      if (!el) return;
      const c = W.cars[i];
      const dead = !c.alive || c.falling;
      el.d.classList.toggle('dead', dead);
      el.d.classList.toggle('sel', i === specId && !dead);
      el.bar.style.width = ((dead ? 0 : c.hp) / MAX_HP * 100).toFixed(0) + '%';
    });
    $('specExit').textContent = isOnline ? 'Выйти' : 'Выйти (+5 🪙)';
    if (!tgt) $('specTxt').textContent += '';
  } else {
    $('hud').classList.remove('spec');
    if (!out) $('spec').style.display = 'none';
  }
  if (W.state === 'ended' && W.endT > 1.8 && !resultShown) showResult();

  // звук: двигатель по скорости, толпа по накалу
  const ratio = Math.min(1, Math.hypot(player.vx, player.vz) / (player.def.speed * SPEED_MUL));
  if (player.alive && !player.falling) A.engine.set(ratio, Math.hypot(rawX, rawY), player.jy > 0.15);
  else A.engine.set(0, 0, false);
  excite = Math.max(0.2, excite - dt * 0.12);
  A.crowd.level(excite);
}

function showResult() {
  resultShown = true;
  const won = W.winner === player;
  const r = applyReward(won);
  $('spec').style.display = 'none';
  $('big').textContent = '';
  $('rTitle').textContent = won ? '🏆 Победа!' : '💀 Поражение';
  let html = `<div>Награда: <span class="coin">+${r.coins} 🪙</span></div><div>Опыт: <b>${r.xp > 0 ? '+' : ''}${r.xp}</b></div>`;
  if (r.after > r.before) html += `<div style="color:#4ade80">⬆ Новый уровень: ${r.after}!</div>`;
  if (r.after < r.before) html += `<div style="color:#f87171">⬇ Уровень понижен: ${r.after}</div>`;
  if (r.gifts.coins) html += `<div class="coin">Награда за уровень: +${r.gifts.coins} 🪙</div>`;
  if (r.gifts.boxes) html += `<div style="color:#c084fc">🎁 Получен ящик!</div>`;
  if (r.gifts.car >= 0) html += `<div style="color:#fbbf24">🏆 Уровень 100! Открыта «${CARS[r.gifts.car].name}»</div>`;
  $('rInfo').innerHTML = html;
  $('rAgain').textContent = isOnline ? '↩ В комнату' : '▶ Ещё раз';
  (won ? A.sfx.win : A.sfx.lose)();
  show('result');
}

function leaveMatch() {
  if (W && !resultShown) {
    const r = applyReward(false);
    toast(`+${r.coins} 🪙, опыт ${r.xp}`);
  }
  if (isOnline) N.send({ t: 'leave' });
  endToMenu();
}

// ---------------------------------------------------------------- онлайн: применяем снимки сервера к локальному «зеркалу» мира
const lerp = (a, b, k) => a + (b - a) * k;
function applyNet(dt) {
  const smp = N.sample();
  if (!smp) return;
  const { a, b, k, latest } = smp;
  const wasEnded = W.state === 'ended';
  W.state = ['countdown', 'play', 'ended'][latest.st];
  W.countdown = latest.cd;
  W.playT = latest.pt;
  W.rFlat = latest.rf;
  W.rTop = latest.rt;
  W.lavaY = latest.ly;
  W.shrinking = !!latest.sk;
  W.winner = latest.win >= 0 ? W.cars[latest.win] : null;
  if (W.state === 'ended') W.endT = wasEnded ? W.endT + dt : 0;
  W.cars.forEach((c, i) => {
    const A0 = a.c[i];
    const B0 = b.c[i];
    const L = latest.c[i];
    if (!A0 || !B0) return;
    c.x = lerp(A0[0], B0[0], k);
    c.z = lerp(A0[1], B0[1], k);
    c.h = A0[2] + angDiff(A0[2], B0[2]) * k;
    c.y = lerp(A0[3], B0[3], k);
    c.jy = lerp(A0[4], B0[4], k);
    c.hp = L[5];
    const f = L[6];
    c.alive = !!(f & 1);
    c.falling = !!(f & 2);
    c.shield = !!(f & 4);
    c.wrecked = !!(f & 8);
    c.ability = L[7] >= 0 ? ABILITIES[L[7]] : null;
    c.jumpCd = L[8];
    c.vx = lerp(A0[9], B0[9], k);
    c.vz = lerp(A0[10], B0[10], k);
    c.place = L[11];
    c.jvy = (B0[4] - A0[4]) * 20;
  });
  W.pads.forEach((p, i) => {
    const v = latest.p[i];
    p.off = v === -2;
    p.type = v >= 0 ? ABILITIES[v] : null;
    const pr = Math.min(p.r0, W.rFlat - 4);
    p.x = Math.cos(p.a) * pr;
    p.z = Math.sin(p.a) * pr;
  });
  const sh = b.sh;
  while (W.shots.length > sh.length) W.shots.pop();
  sh.forEach((s, i) => {
    const o = W.shots[i] || (W.shots[i] = {});
    o.k = s[0] === 0 ? 'missile' : 'arrow';
    o.x = s[1]; o.z = s[2]; o.h = s[3]; o.owner = s[4];
  });
  // события из снимков, время которых уже наступило
  const now = performance.now() - 100;
  for (const sn of N.net.snaps) {
    if (sn.done || sn.at > now) continue;
    sn.done = true;
    for (const e of sn.ev) W.events.push(e);
  }
}

// ---------------------------------------------------------------- управление
const zone = $('zone');
const base = $('stickBase');
const thumb = $('stickThumb');
let stickId = null;
let stickO = { x: 0, y: 0 };
let lastX = 0;
let lastY = 0;
const keys = {};
const STICK_R = 55;
let rawX = 0;
let rawY = 0;
let pendUse = false;
let pendJump = false;
let sentAt = 0;
let sentX = 9;
let sentZ = 9;

function inputVec() {
  const fx = Math.cos(cam.yaw);
  const fz = Math.sin(cam.yaw);
  return [-fz * rawX + fx * -rawY, fx * rawX + fz * -rawY];
}
function applyInput() {
  if (!player || !W) return;
  const dead = player.falling || !player.alive;
  const [sx, sz] = dead ? [0, 0] : inputVec();
  if (isOnline) {
    const now = performance.now();
    if (pendUse || pendJump || now - sentAt > 50) {
      if (pendUse || pendJump || Math.abs(sx - sentX) > 0.02 || Math.abs(sz - sentZ) > 0.02 || now - sentAt > 250) {
        N.send({ t: 'in', sx: +sx.toFixed(3), sz: +sz.toFixed(3), use: pendUse, jump: pendJump });
        sentAt = now; sentX = sx; sentZ = sz; pendUse = false; pendJump = false;
      }
    }
    return;
  }
  player.input.sx = sx;
  player.input.sz = sz;
  if (pendUse) { player.input.use = true; pendUse = false; }
  if (pendJump) { player.input.jump = true; pendJump = false; }
}

zone.addEventListener('pointerdown', (e) => {
  A.initAudio();
  if (stickId !== null) return;
  stickId = e.pointerId;
  zone.setPointerCapture(e.pointerId);
  lastX = e.clientX; lastY = e.clientY;
  if (isSpec()) { cam.drag = 1; return; }
  stickO = { x: e.clientX, y: e.clientY };
  base.style.display = 'block';
  base.style.left = e.clientX + 'px';
  base.style.top = e.clientY + 'px';
  thumb.style.left = '36px';
  thumb.style.top = '36px';
});
zone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== stickId) return;
  if (cam.drag) {
    // наблюдение: тянем пальцем — крутим камеру, вертикально — приближение
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    cam.off -= dx * 0.008;
    cam.orbit -= dx * 0.008;
    cam.zoom = Math.max(0.5, Math.min(2.2, cam.zoom + dy * 0.004));
    return;
  }
  let dx = e.clientX - stickO.x;
  let dy = e.clientY - stickO.y;
  const d = Math.hypot(dx, dy);
  if (d > STICK_R) { dx = (dx / d) * STICK_R; dy = (dy / d) * STICK_R; }
  thumb.style.left = 36 + dx + 'px';
  thumb.style.top = 36 + dy + 'px';
  rawX = dx / STICK_R;
  rawY = dy / STICK_R;
});
const stickEnd = (e) => {
  if (e.pointerId !== stickId) return;
  stickId = null;
  cam.drag = 0;
  base.style.display = 'none';
  rawX = 0;
  rawY = 0;
};
zone.addEventListener('pointerup', stickEnd);
zone.addEventListener('pointercancel', stickEnd);

const useAbility = () => { if (player && mode === 'game' && player.alive) { pendUse = true; if (isOnline) applyInput(); } };
const doJump = () => { if (player && mode === 'game' && player.alive) { pendJump = true; if (isOnline) applyInput(); } };
$('abil').addEventListener('pointerdown', (e) => { e.preventDefault(); A.initAudio(); useAbility(); });
$('jump').addEventListener('pointerdown', (e) => { e.preventDefault(); A.initAudio(); doJump(); });

function keyVec() {
  let x = 0;
  let y = 0;
  if (keys.ArrowLeft || keys.a) x -= 1;
  if (keys.ArrowRight || keys.d) x += 1;
  if (keys.ArrowUp || keys.w) y -= 1;
  if (keys.ArrowDown || keys.s) y += 1;
  const l = Math.hypot(x, y);
  return l ? [x / l, y / l] : [0, 0];
}
window.addEventListener('keydown', (e) => {
  keys[e.key] = true;
  if (e.key === ' ') doJump();
  if (e.key === 'e' || e.key === 'Enter') useAbility();
  if (stickId === null && mode === 'game') [rawX, rawY] = keyVec();
});
window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
  if (stickId === null && mode === 'game') [rawX, rawY] = keyVec();
});

// ---------------------------------------------------------------- витрина (лобби / гараж / осмотр)
const showroom = createShowroom(envTex);
let idleT = 0;
const dragEl = $('drag');
let dp = null;
let onCarTap = null;
dragEl.addEventListener('pointerdown', (e) => {
  A.initAudio();
  dp = { id: e.pointerId, x: e.clientX, x0: e.clientX, y0: e.clientY, t: performance.now(), moved: 0 };
  dragEl.setPointerCapture(e.pointerId);
  showroom.auto = false;
  showroom.vel = 0;
  idleT = 0;
});
dragEl.addEventListener('pointermove', (e) => {
  if (!dp || e.pointerId !== dp.id) return;
  const dx = e.clientX - dp.x;
  dp.x = e.clientX;
  dp.moved += Math.abs(dx);
  showroom.yaw += dx * 0.012;
  showroom.vel = dx * 0.012 * 60 * 0.6;
  idleT = 0;
});
const dragEnd = (e) => {
  if (!dp || e.pointerId !== dp.id) return;
  const tap = dp.moved < 8 && performance.now() - dp.t < 450;
  dp = null;
  if (tap && onCarTap) onCarTap();
};
dragEl.addEventListener('pointerup', dragEnd);
dragEl.addEventListener('pointercancel', () => { dp = null; });

// ---------------------------------------------------------------- экраны
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('on');
  $(id).classList.add('on');
  const clear = ['menu', 'garage', 'inspect'].includes(id);
  dragEl.style.display = clear || id === 'settings' ? 'block' : 'none';
  $('drag').style.pointerEvents = clear ? 'auto' : 'none';
}
let toastT = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.style.display = 'none'; }, 2400);
}
const click = () => A.sfx.click();

function showMenu() {
  const li = levelInfo(S.xp);
  $('mIcon').textContent = ICONS[S.icon] || ICONS[0];
  $('mName').textContent = S.name;
  $('mLvl').textContent = li.level >= MAX_LEVEL ? 'MAX' : li.level;
  $('mXp').style.width = Math.round((li.cur / li.need) * 100) + '%';
  $('mCoins').textContent = S.coins;
  $('mBoxes').textContent = S.boxes ? `🎁 ${S.boxes}` : '';
  const a = ARENAS[S.arena];
  const c = $('aCard');
  c.textContent = `${a.emoji} ${a.name}`;
  c.style.background = `linear-gradient(135deg, ${a.bg[0]}, ${a.bg[1]})`;
  showroom.setCar(CARS[S.car]);
  showroom.setMode('lobby');
  showroom.auto = true;
  onCarTap = null;
  show('menu');
  if (A.audioReady()) A.musicStart();
}

function norm(v, lo, hi) { return Math.max(4, Math.min(100, Math.round(((v - lo) / (hi - lo)) * 100))); }
const RAR = { common: 'Обычная', rare: 'Редкая', epic: 'Эпическая', legendary: 'Легендарная' };
const KIND = { hatch: 'Хэтчбек', sedan: 'Седан', pickup: 'Пикап', coupe: 'Купе', buggy: 'Багги', suv: 'Внедорожник', muscle: 'Мускул-кар', roadster: 'Родстер', cabrio: 'Кабриолет', rally: 'Раллийная', sport: 'Спорткар', dragster: 'Дрэг', monster: 'Монстр-трак', electric: 'Электрокар', hyper: 'Гиперкар', futuro: 'Концепт' };
const hexOf = (n) => '#' + n.toString(16).padStart(6, '0');

// ---- гараж
let gSel = 0;
let gActions = false;
function showGarage() {
  gSel = S.car;
  gActions = false;
  showroom.setCar(CARS[gSel]);
  showroom.setMode('lobby');
  showroom.auto = true;
  onCarTap = () => { gActions = !gActions; renderGarage(); click(); };
  renderGarage();
  show('garage');
}
function renderGarage() {
  $('gCoins').textContent = S.coins;
  $('gBox').textContent = S.boxes ? `🎁 Ящик (${S.boxes})` : `🎁 Ящик 🪙${BOX_PRICE}`;
  const car = CARS[gSel];
  $('gName').innerHTML = `<b>${car.name}</b> <span class="rar-${car.rarity}">${RAR[car.rarity]}</span>`;
  const list = $('gList');
  list.innerHTML = '';
  for (const c of CARS) {
    const owned = S.owned.includes(c.id);
    const d = document.createElement('div');
    d.className = 'gc' + (gSel === c.id ? ' sel' : '') + (owned ? '' : ' lock');
    d.dataset.id = c.id;
    d.innerHTML = `<div class="sw" style="background:linear-gradient(135deg,${hexOf(c.color)},${hexOf(c.accent)})">🚗</div><div class="gn">${c.name}</div><div class="gp ${S.car === c.id ? 'cur' : ''}">${S.car === c.id ? '✔ выбрана' : owned ? 'в гараже' : '🪙 ' + c.price}</div>`;
    list.appendChild(d);
  }
  const sel = list.querySelector('.sel');
  if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
  const act = $('gAct');
  act.style.display = gActions ? 'flex' : 'none';
  const owned = S.owned.includes(gSel);
  const b = $('bBuy');
  if (owned) {
    b.className = S.car === gSel ? 'gray' : 'green';
    b.textContent = S.car === gSel ? '✔ Выбрана' : 'Выбрать';
    b.disabled = S.car === gSel;
  } else {
    b.className = 'gold';
    b.textContent = `🛒 Купить 🪙${car.price}`;
    b.disabled = S.coins < car.price;
  }
}
function selectCar(id) {
  gSel = id;
  gActions = true;
  showroom.setCar(CARS[id]);
  renderGarage();
}
$('gList').addEventListener('click', (e) => {
  const d = e.target.closest('.gc');
  if (d) { click(); selectCar(+d.dataset.id); }
});
function buyOrSelect() {
  const car = CARS[gSel];
  if (S.owned.includes(gSel)) {
    S.car = gSel;
    persist();
    toast(`Выбрана: ${car.name}`);
  } else if (S.coins >= car.price) {
    S.coins -= car.price;
    S.owned.push(gSel);
    S.car = gSel;
    persist();
    A.sfx.pickup();
    toast(`Куплено: ${car.name}!`);
  }
}
$('bBuy').onclick = () => { buyOrSelect(); renderGarage(); };
$('gBack').onclick = () => { click(); showMenu(); };
$('gBox').onclick = () => {
  click();
  if (S.boxes > 0) S.boxes--;
  else if (S.coins >= BOX_PRICE) S.coins -= BOX_PRICE;
  else { toast(`Нужно ${BOX_PRICE} 🪙`); return; }
  const un = CARS.filter((c) => !S.owned.includes(c.id));
  if (!un.length) { S.coins += 150; persist(); toast('Все машины уже есть! +150 🪙'); renderGarage(); return; }
  const W8 = { common: 55, rare: 28, epic: 12, legendary: 5 };
  const rars = [...new Set(un.map((c) => c.rarity))];
  let r = Math.random() * rars.reduce((s, k) => s + W8[k], 0);
  let rar = rars[0];
  for (const k of rars) { r -= W8[k]; if (r <= 0) { rar = k; break; } }
  const pool = un.filter((c) => c.rarity === rar);
  const car = pool[(Math.random() * pool.length) | 0];
  S.owned.push(car.id);
  persist();
  A.sfx.win();
  toast(`🎁 Выпала: ${car.name} (${RAR[car.rarity]})`);
  selectCar(car.id);
};

// ---- осмотр машины: справа окно с характеристиками, машину можно крутить на 360°
function openInspect() {
  click();
  const c = CARS[gSel];
  $('iTitle').innerHTML = `<b>${c.name}</b><div class="rar-${c.rarity}" style="font-size:13px">${RAR[c.rarity]} · ${KIND[c.kind]}</div>`;
  const rows = [
    ['Скорость', Math.round(c.speed * SPEED_MUL * 3.6) + ' км/ч', norm(c.speed, 14, 18)],
    ['Разгон', c.accel.toFixed(0) + ' ед.', norm(c.accel, 24, 40)],
    ['Поворот', c.turn.toFixed(1) + ' рад/с', norm(c.turn, 4, 5.8)],
    ['Масса', Math.round(c.mass * 1300) + ' кг', norm(c.mass, 0.85, 1.55)],
    ['Длина', (c.body.len * 1.3).toFixed(1) + ' м', norm(c.body.len, 2.8, 3.9)],
    ['Колёса', Math.round(c.body.wr * 2 * 1.3 * 100) + ' см', norm(c.body.wr, 0.35, 1)],
  ];
  $('iRows').innerHTML = rows.map(([n, v, k]) => `<div class="ir"><div class="in"><span>${n}</span><b>${v}</b></div><div class="bar"><i style="width:${k}%"></i></div></div>`).join('') +
    `<div class="ir"><div class="in"><span>Цена</span><b class="coin">${c.price ? '🪙 ' + c.price : 'бесплатно'}</b></div></div>`;
  const owned = S.owned.includes(gSel);
  $('iBuy').className = owned ? (S.car === gSel ? 'gray' : 'green') : 'gold';
  $('iBuy').textContent = owned ? (S.car === gSel ? '✔ Выбрана' : 'Выбрать') : `🛒 Купить 🪙${c.price}`;
  $('iBuy').disabled = owned ? S.car === gSel : S.coins < c.price;
  showroom.setMode('inspect');
  showroom.auto = false;
  onCarTap = null;
  show('inspect');
}
$('bInspect').onclick = openInspect;
$('iBuy').onclick = () => { buyOrSelect(); openInspect(); };
$('iBack').onclick = () => { click(); showroom.setMode('lobby'); showroom.auto = true; onCarTap = () => { gActions = !gActions; renderGarage(); click(); }; renderGarage(); show('garage'); };

// ---- настройки
let tmpSide = 'left';
let tmpIcon = 0;
function paintSide() {
  $('sLeft').className = tmpSide === 'left' ? 'green' : 'gray';
  $('sRight').className = tmpSide === 'right' ? 'green' : 'gray';
}
function paintIcons() {
  $('sIcons').innerHTML = ICONS.map((ic, i) => `<button data-i="${i}" class="${i === tmpIcon ? 'green' : 'gray'} ico">${ic}</button>`).join('');
}
function showSettings() {
  $('sVol').value = Math.round(S.vol * 100);
  $('sMus').value = Math.round(S.mus * 100);
  $('sBtn').value = Math.round(S.btn * 100);
  $('sName').value = S.name;
  $('sServer').value = S.server || N.DEFAULT_SERVER || '';
  tmpSide = S.side;
  tmpIcon = S.icon;
  paintSide();
  paintIcons();
  show('settings');
}
$('sLeft').onclick = () => { tmpSide = 'left'; paintSide(); };
$('sRight').onclick = () => { tmpSide = 'right'; paintSide(); };
$('sIcons').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { tmpIcon = +b.dataset.i; paintIcons(); click(); } });
let saved = { vol: S.vol, mus: S.mus };
$('sVol').oninput = () => { S.vol = $('sVol').value / 100; A.setVolumes(); A.sfx.click(); };
$('sMus').oninput = () => { S.mus = $('sMus').value / 100; A.setVolumes(); };
$('sSave').onclick = () => {
  S.vol = $('sVol').value / 100;
  S.mus = $('sMus').value / 100;
  S.btn = $('sBtn').value / 100;
  S.side = tmpSide;
  S.icon = tmpIcon;
  const n = $('sName').value.trim();
  if (n) S.name = n.slice(0, 14);
  const sv = $('sServer').value.trim();
  if (sv !== S.server) { S.server = sv; N.disconnect(); }
  saved = { vol: S.vol, mus: S.mus };
  persist();
  A.setVolumes();
  if (N.online() && n) N.send({ t: 'name', name: S.name });
  toast('Сохранено');
  showMenu();
};
$('sBack').onclick = () => { S.vol = saved.vol; S.mus = saved.mus; A.setVolumes(); showMenu(); };
$('sTest').onclick = async () => {
  const sv = $('sServer').value.trim();
  if (sv !== S.server) { S.server = sv; N.disconnect(); persist(); }
  toast('Подключаюсь…');
  const r = await N.connect();
  toast(r.ok ? '✅ Сервер доступен' : '❌ ' + failText(r.reason));
};
function failText(r) {
  return r === 'noserver' ? 'Адрес сервера не указан (Настройки)' : r === 'timeout' ? 'Сервер не отвечает (бесплатный Render просыпается ~30 с — попробуй ещё раз)' : 'Не удалось подключиться';
}

$('nameOk').onclick = () => {
  const n = $('nameIn').value.trim();
  if (!n) { toast('Введи ник'); return; }
  S.name = n.slice(0, 14);
  persist();
  A.initAudio();
  A.setVolumes();
  showMenu();
};

// ---- меню / лобби
$('aPrev').onclick = () => { click(); S.arena = (S.arena + ARENAS.length - 1) % ARENAS.length; persist(); showMenu(); };
$('aNext').onclick = () => { click(); S.arena = (S.arena + 1) % ARENAS.length; persist(); showMenu(); };
$('bPlay').onclick = () => { click(); startOffline(); };
$('bGarage').onclick = () => { click(); showGarage(); };
$('bSet').onclick = () => { click(); showSettings(); };
$('musNext').onclick = () => { A.initAudio(); A.musicStart(); A.musicNext(); };
setInterval(() => { if (mode === 'menu') $('musTxt').textContent = A.musicPlaying() ? '♪ ' + A.musicName() : '♪ музыка'; }, 800);
const firstGesture = () => { A.initAudio(); A.setVolumes(); if (mode === 'menu' && S.name) A.musicStart(); };
window.addEventListener('pointerdown', firstGesture, { once: true });

// ---- онлайн
async function ensureOnline() {
  if (N.online()) return true;
  toast('Подключаюсь к серверу…');
  const r = await N.connect();
  if (!r.ok) {
    toast('❌ ' + failText(r.reason));
    if (r.reason === 'noserver') showSettings();
    return false;
  }
  return true;
}
$('bOnline').onclick = async () => {
  click();
  if (!(await ensureOnline())) return;
  $('oStatus').textContent = '';
  $('oQuick').textContent = '⚡ Быстрая игра';
  qSearching = false;
  show('online');
};
let qSearching = false;
$('oBack').onclick = () => { click(); if (qSearching) N.send({ t: 'unqueue' }); qSearching = false; showMenu(); };
$('oQuick').onclick = () => {
  click();
  if (qSearching) { N.send({ t: 'unqueue' }); qSearching = false; $('oQuick').textContent = '⚡ Быстрая игра'; $('oStatus').textContent = ''; return; }
  qSearching = true;
  N.send({ t: 'quick', car: S.car });
  $('oQuick').textContent = '✖ Отменить поиск';
  $('oStatus').textContent = 'Ищем игроков… (если никого нет — добавим ботов)';
};
$('oCreate').onclick = () => { click(); N.send({ t: 'create', car: S.car }); };
$('oJoin').onclick = () => { click(); const c = $('oCode').value.trim(); if (c) N.send({ t: 'join', code: c, car: S.car }); };

function renderRoom() {
  const r = N.net.room;
  if (!r) return;
  $('rmCode').textContent = r.code;
  const me = r.players.find((p) => p.pid === S.pid);
  const host = !!(me && me.host);
  $('rmPlayers').innerHTML = r.players.map((p) => `<div class="pl"><span>${p.host ? '👑' : '👤'} <b>${p.name}</b>${p.pid === S.pid ? ' (вы)' : ''}</span><span class="sub">${(CARS[p.car] || CARS[0]).name}</span></div>`).join('') +
    Array.from({ length: Math.max(0, 4 - r.players.length) }, () => '<div class="pl dim2">… свободно (заполнится ботами)</div>').join('');
  const a = ARENAS[r.arena] || ARENAS[0];
  $('rmArena').textContent = `${a.emoji} ${a.name}`;
  $('rmPrev').style.visibility = $('rmNext').style.visibility = host ? 'visible' : 'hidden';
  $('rmStart').style.display = host ? 'inline-block' : 'none';
  $('rmWait').style.display = host ? 'none' : 'block';
}
N.on('room', () => {
  qSearching = false;
  if (mode === 'menu' || (mode === 'game' && resultShown)) {
    if (mode === 'game') return; // после матча покажем комнату по кнопке
    renderRoom();
    show('room');
    showroom.setCar(CARS[S.car]);
  }
});
N.on('start', (m) => { qSearching = false; startOnline(m); });
N.on('err', (m) => { toast(m.m); });
N.on('info', (m) => { toast(m.m); });
N.on('left', () => {});
N.on('invite', (m) => {
  if (mode === 'menu' && confirm(`${m.from} зовёт тебя в комнату. Войти?`)) N.send({ t: 'join', code: m.code, car: S.car });
});
N.on('closed', () => {
  if (mode === 'game' && isOnline) { toast('Связь с сервером потеряна'); endToMenu(); }
  else if (mode === 'menu' && !$('menu').classList.contains('on')) { toast('Связь с сервером потеряна'); showMenu(); }
});
$('rmPrev').onclick = () => { const r = N.net.room; if (r) N.send({ t: 'arena', i: r.arena - 1 }); };
$('rmNext').onclick = () => { const r = N.net.room; if (r) N.send({ t: 'arena', i: r.arena + 1 }); };
$('rmStart').onclick = () => { click(); N.send({ t: 'start' }); };
$('rmLeave').onclick = () => { click(); N.send({ t: 'leave' }); N.net.room = null; $('oStatus').textContent = ''; show('online'); };
$('rmFriends').onclick = () => { click(); openFriends(true); };

// ---- друзья
let fTab = 'list';
let fFromRoom = false;
async function openFriends(fromRoom = false) {
  fFromRoom = fromRoom;
  if (!(await ensureOnline())) return;
  N.send({ t: 'flist' });
  $('fMyId').textContent = S.pid;
  fTab = 'list';
  renderFriends();
  show('friends');
}
$('bFriends').onclick = () => { click(); openFriends(false); };
$('fBack').onclick = () => { click(); if (fFromRoom && N.net.room) { renderRoom(); show('room'); } else showMenu(); };
$('fCopy').onclick = () => { try { navigator.clipboard.writeText(S.pid); toast('ID скопирован'); } catch { toast('ID: ' + S.pid); } };
document.querySelectorAll('#fTabs button').forEach((b) => { b.onclick = () => { click(); fTab = b.dataset.t; renderFriends(); }; });
let fFound = null;
function renderFriends() {
  const F = N.net.friends;
  document.querySelectorAll('#fTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === fTab));
  $('fReqBadge').textContent = F.inc.length ? ` (${F.inc.length})` : '';
  const box = $('fList');
  $('fSearchBox').style.display = fTab === 'find' ? 'flex' : 'none';
  if (fTab === 'list') {
    box.innerHTML = F.friends.length ? F.friends.map((f) => `<div class="pl"><span><i class="dot ${f.online ? 'on' : ''}"></i> <b>${f.name}</b> <span class="sub">${f.pid}</span></span><span class="row">${fFromRoom && f.online ? `<button data-inv="${f.pid}" class="green sm">Позвать</button>` : ''}<button data-rm="${f.pid}" class="gray sm">✕</button></span></div>`).join('') : '<div class="sub" style="padding:16px">Друзей пока нет. Найдите игрока по ID на вкладке «Поиск».</div>';
  } else if (fTab === 'req') {
    box.innerHTML = F.inc.length ? F.inc.map((f) => `<div class="pl"><span><b>${f.name}</b> <span class="sub">${f.pid}</span></span><span class="row"><button data-ok="${f.pid}" class="green sm">Принять</button><button data-no="${f.pid}" class="red sm">Отклонить</button></span></div>`).join('') : '<div class="sub" style="padding:16px">Входящих запросов нет</div>';
    if (F.out.length) box.innerHTML += '<div class="sub" style="padding:8px">Отправлено:</div>' + F.out.map((f) => `<div class="pl dim2"><span>${f.name} <span class="sub">${f.pid}</span></span><span class="sub">ожидает</span></div>`).join('');
  } else {
    box.innerHTML = fFound ? (fFound.found
      ? `<div class="pl"><span><i class="dot ${fFound.online ? 'on' : ''}"></i> <b>${fFound.name}</b> <span class="sub">${fFound.pid}</span></span>${{ none: `<button data-add="${fFound.pid}" class="green sm">+ Добавить</button>`, sent: '<span class="sub">запрос отправлен</span>', friend: '<span class="sub">уже друг</span>', incoming: `<button data-ok="${fFound.pid}" class="green sm">Принять</button>`, self: '<span class="sub">это вы</span>' }[fFound.status]}</span></div>`
      : '<div class="sub" style="padding:16px">Игрок с таким ID не найден</div>') : '';
  }
}
N.on('friends', () => { if ($('friends').classList.contains('on')) renderFriends(); });
N.on('fsearch', (m) => { fFound = m; renderFriends(); });
$('fSearch').onclick = () => { click(); const v = $('fIn').value.replace(/\D/g, ''); if (v.length < 6) { toast('Введите ID игрока (14 цифр)'); return; } N.send({ t: 'fsearch', pid: v }); };
$('fList').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  click();
  const d = b.dataset;
  if (d.add) { N.send({ t: 'freq', pid: d.add }); if (fFound) fFound.status = 'sent'; renderFriends(); }
  else if (d.ok) { N.send({ t: 'fans', pid: d.ok, ok: true }); if (fFound && fFound.pid === d.ok) fFound.status = 'friend'; }
  else if (d.no) N.send({ t: 'fans', pid: d.no, ok: false });
  else if (d.rm) { if (confirm('Удалить из друзей?')) N.send({ t: 'fremove', pid: d.rm }); }
  else if (d.inv) { N.send({ t: 'invite', pid: d.inv }); toast('Приглашение отправлено'); }
});

// ---- матч / результат / наблюдение
$('rAgain').onclick = () => {
  click();
  if (isOnline) {
    endToMenu();
    if (N.net.room) { renderRoom(); show('room'); } else show('online');
  } else { endToMenu(); startOffline(); }
};
$('rMenu').onclick = () => { click(); if (isOnline) N.send({ t: 'leave' }); endToMenu(); };
$('specExit').onclick = () => { click(); leaveMatch(); };
$('chips').addEventListener('click', (e) => {
  const b = e.target.closest('.chipb');
  if (!b) return;
  const id = +b.dataset.id;
  if (W.cars[id] && W.cars[id].alive && !W.cars[id].falling) { specId = id; if (SPEC_MODES[specMode] === 'auto') specMode = 1; click(); }
});
function specStep(dir) {
  const live = W ? W.cars.filter((c) => c.alive && !c.falling) : [];
  if (!live.length) return;
  const i = live.findIndex((c) => c.id === specId);
  specId = live[(i + dir + live.length) % live.length].id;
  if (SPEC_MODES[specMode] === 'auto') specMode = 1;
  click();
}
$('specNext').onclick = () => specStep(1);
$('specPrev').onclick = () => specStep(-1);
$('specMode').onclick = () => { specMode = (specMode + 1) % SPEC_MODES.length; specAutoT = 0; cam.zoom = 1; click(); };
$('pause').onclick = () => {
  if (!W || resultShown) return;
  if (confirm('Выйти из матча? Это будет засчитано как поражение.')) leaveMatch();
};

// ---------------------------------------------------------------- главный цикл
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (mode === 'game' && W) {
    if (isOnline) {
      applyNet(dt);
      applyInput();
    } else {
      applyInput();
      accum += dt;
      let n = 0;
      while (accum >= 1 / 60 && n < 5) {
        stepWorld(W, 1 / 60);
        accum -= 1 / 60;
        n++;
      }
    }
    handleEvents();
    syncViews(dt);
    updateCamera(dt);
    updateHud(dt);
    updateRings(dt);
    updateFlashes(dt);
    updateDomes(dt);
    updateDebris(dt);
    updateBurners(dt);
    fxAdd.update(dt);
    fxMix.update(dt);
    renderer.render(scene, camera);
  } else {
    idleT += dt;
    if (!dp && idleT > 4 && !showroom.auto && showroom.mode !== 'inspect') showroom.auto = true;
    showroom.update(dt);
    renderer.render(showroom.scene, showroom.camera);
  }
}
function onResize2() {
  onResize();
  showroom.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize2);
onResize2();
requestAnimationFrame(frame);

// старт
if (S.name) showMenu();
