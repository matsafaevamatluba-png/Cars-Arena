// showroom.js — «витрина»: вращающаяся площадка с машиной в центре (лобби, гараж, осмотр)
import * as THREE from 'three';
import { buildCar, softTex } from './carmodel.js';

export function createShowroom(envTex) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d1c);
  scene.fog = new THREE.Fog(0x0a0d1c, 22, 60);
  if (envTex) { scene.environment = envTex; scene.environmentIntensity = 0.9; }
  const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 200);

  // фон: тёмный «ангар» с неоновыми полосами
  const bgc = document.createElement('canvas');
  bgc.width = 512; bgc.height = 256;
  const g = bgc.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, '#0b1030'); gr.addColorStop(0.55, '#1b2350'); gr.addColorStop(1, '#0a0d1c');
  g.fillStyle = gr; g.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(120,170,255,${0.05 + Math.random() * 0.12})`;
    g.fillRect(i * 13, 40 + Math.random() * 60, 3, 120 + Math.random() * 80);
  }
  const bgTex = new THREE.CanvasTexture(bgc);
  bgTex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(80, 24, 12), new THREE.MeshBasicMaterial({ map: bgTex, side: THREE.BackSide, fog: false, toneMapped: false }));
  scene.add(dome);

  // площадка
  const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: 0x0f1328, roughness: 0.32, metalness: 0.7 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const plat = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.9, 0.28, 64), new THREE.MeshStandardMaterial({ color: 0x1a2040, roughness: 0.3, metalness: 0.85 }));
  plat.position.y = 0.14;
  plat.receiveShadow = true;
  scene.add(plat);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.65, 0.07, 8, 96), ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.29;
  scene.add(ring);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshBasicMaterial({ color: 0x2b7bff, map: softTex, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.02;
  scene.add(glow);

  // свет: ключевой прожектор + контровые
  scene.add(new THREE.HemisphereLight(0x9db8ff, 0x1a1030, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(-6, 9, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
  key.shadow.bias = -0.0005;
  scene.add(key);
  const rim1 = new THREE.DirectionalLight(0x6aa8ff, 2.0);
  rim1.position.set(8, 4, -7);
  scene.add(rim1);
  const rim2 = new THREE.DirectionalLight(0xff7ac8, 1.4);
  rim2.position.set(-8, 3, -6);
  scene.add(rim2);

  const turn = new THREE.Group(); // вращается вместе с машиной
  scene.add(turn);

  const S = { scene, camera, turn, view: null, yaw: 0.6, pitch: 0.2, dist: 8.2, shiftX: 0, auto: true, vel: 0, id: -1, mode: 'lobby', t: 0 };

  S.setCar = (def) => {
    if (S.view) {
      turn.remove(S.view.holder);
      S.view.holder.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      S.view = null;
    }
    S.id = def.id;
    S.view = buildCar(def, false, '#38bdf8', 'show');
    S.view.holder.position.y = 0.28;
    S.view.holder.scale.setScalar(1.45);
    S.view.holder.rotation.y = -Math.PI * 0.5;
    turn.add(S.view.holder);
    ringMat.color.setHex(def.glow || def.accent || 0x38bdf8);
    // подстраиваем дистанцию камеры под размер
    S.dist = 7.6 + def.body.len * 0.9;
  };
  // mode: lobby — машина по центру, inspect — смещена влево, справа окно характеристик
  S.setMode = (m) => { S.mode = m; };
  S.resize = (w, h) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  S.update = (dt) => {
    S.t += dt;
    if (S.auto) S.yaw += dt * 0.35;
    else {
      S.yaw += S.vel * dt;
      S.vel *= Math.exp(-2.2 * dt);
      if (Math.abs(S.vel) < 0.05) S.vel = 0;
    }
    turn.rotation.y = S.yaw;
    if (S.view) {
      const v = S.view;
      for (const w of v.wheels) w.rotation.z -= dt * 0.3;
      v.holder.position.y = 0.28 + Math.sin(S.t * 1.6) * 0.012;
    }
    const target = S.mode === "inspect" ? 0.24 : 0;
    S.shiftX += (target - S.shiftX) * (1 - Math.exp(-6 * dt));
    const d = S.dist;
    camera.position.set(0, 1.5 + d * 0.16, d);
    camera.lookAt(0, 0.95, 0);
    // смещение кадра вбок: машина остаётся в оставшейся части экрана
    camera.setViewOffset(window.innerWidth, window.innerHeight, S.shiftX * window.innerWidth * 0.5, 0, window.innerWidth, window.innerHeight);
  };
  return S;
}
