/**
 * NeonCity3D — Scroll-driven wireframe city scene
 * Plain JavaScript (ES modules) + Three.js
 * EIC IIIT Una Digital Ecosystem Backdrop
 */

import * as THREE from 'three';

// ─── Reduced-motion check ────────────────────────────────────────────────────
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Color constants ─────────────────────────────────────────────────────────
const CYAN   = 0x00e5ff;
const TEAL   = 0x00bcd4;
const YELLOW = 0xe0c253;
const BG     = 0x050811;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('city-canvas');

// ─── Renderer ────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(BG, 1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.88;

// ─── Scene + Camera ──────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.fog   = new THREE.FogExp2(BG, 0.024);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
camera.position.set(0, 8, 40);

// ─── Resize ──────────────────────────────────────────────────────────────────
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
window.addEventListener('resize', onResize);
onResize();

// ─── Material helpers ────────────────────────────────────────────────────────
function lineMat(color, opacity = 1.0) {
  return new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
  });
}

// ─── Grid floor ──────────────────────────────────────────────────────────────
const grid = new THREE.GridHelper(260, 78, 0x0a2030, 0x0a2030);
grid.material.opacity    = 0.38;
grid.material.transparent = true;
grid.position.y = -2;
scene.add(grid);

// ─── Buildings (Startups & Ecosystem Nodes) ─────────────────────────────────
const buildings = []; // { group, baseX, baseZ, rotSpeed, floatAmp, floatPhase }

function makeBuilding(x, z, w, d, h, color, opacity = 0.7) {
  const group = new THREE.Group();

  // Main wireframe box
  const geo   = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.EdgesGeometry(geo);
  const lines = new THREE.LineSegments(edges, lineMat(color, opacity));
  lines.position.y = h / 2;
  group.add(lines);

  // Horizontal level bands
  const bands   = Math.max(2, Math.floor(h / 2.5));
  const bandMat = lineMat(color, opacity * 0.3);
  for (let i = 1; i < bands; i++) {
    const y    = (i / bands) * h;
    const bGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, 0.02, d));
    const bl   = new THREE.LineSegments(bGeo, bandMat);
    bl.position.y = y;
    group.add(bl);
  }

  // Glowing base trim
  const trimGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 0.06, 0.12, d + 0.06));
  const trim    = new THREE.LineSegments(trimGeo, lineMat(color, 0.88));
  trim.position.y = 0.06;
  group.add(trim);

  // Spire on tall buildings
  if (h > 13) {
    const spireH = h * 0.14;
    const sGeo   = new THREE.EdgesGeometry(new THREE.CylinderGeometry(0.04, 0.16, spireH, 4));
    const sMat   = lineMat(color === CYAN ? CYAN : YELLOW, 0.85);
    const spire  = new THREE.LineSegments(sGeo, sMat);
    spire.position.y = h + spireH / 2;
    group.add(spire);
  }

  group.position.set(x, -2, z);
  scene.add(group);
  return group;
}

const LAYOUT = [
  // left cluster (Ideas & Workshops)
  [ -22, -5,  2.8, 2.8, 22, CYAN,   0.72],
  [ -18, -9,  2.0, 2.0, 14, TEAL,   0.55],
  [ -26,-10,  3.2, 3.2, 18, CYAN,   0.50],
  [ -15, -3,  1.6, 1.6,  9, TEAL,   0.45],
  [ -20,  2,  2.2, 2.2, 16, YELLOW, 0.45],
  // right cluster (E-Summit & Bech Ke Dikhao)
  [  22, -5,  2.8, 2.8, 24, TEAL,   0.72],
  [  18, -9,  2.0, 2.0, 13, CYAN,   0.55],
  [  26,-10,  3.2, 3.2, 17, TEAL,   0.50],
  [  14, -3,  1.6, 1.6, 10, CYAN,   0.45],
  [  21,  2,  2.2, 2.2, 15, YELLOW, 0.45],
  // centre-back (EIC Main Towers)
  [  -8,-28,  3.5, 3.5, 28, CYAN,   0.35],
  [   0,-32,  4.0, 4.0, 32, TEAL,   0.30],
  [   9,-28,  3.5, 3.5, 26, CYAN,   0.35],
  // mid-ground fill
  [ -11,-12,  1.8, 1.8, 11, TEAL,   0.42],
  [  11,-12,  1.8, 1.8, 12, CYAN,   0.42],
  [  -4, -8,  2.4, 2.4, 17, YELLOW, 0.42],
  [   4, -8,  2.4, 2.4, 18, TEAL,   0.42],
  // far sides
  [ -34,-18,  2.0, 2.0, 12, TEAL,   0.22],
  [  34,-18,  2.0, 2.0, 14, CYAN,   0.22],
  [ -30,  0,  2.5, 2.5, 10, YELLOW, 0.20],
  [  30,  0,  2.5, 2.5, 11, TEAL,   0.20],
];

LAYOUT.forEach(([x, z, w, d, h, color, op], i) => {
  const group = makeBuilding(x, z, w, d, h, color, op);
  buildings.push({
    group,
    baseX:      x,
    baseZ:      z,
    rotSpeed:   (i % 2 === 0 ? 1 : -1) * (0.00015 + Math.random() * 0.0001),
    floatAmp:   0.10 + Math.random() * 0.10,
    floatPhase: Math.random() * Math.PI * 2,
  });
});

// ─── Floating Spheres (Opportunities / Nodes) ────────────────────────────────
const spheres = [];
const sphGeo  = new THREE.SphereGeometry(0.22, 10, 8);

const SPHERES = [
  [ -22, -5,  14, CYAN,   4, 0.0008],
  [  22, -5,  16, TEAL,   5, 0.0007],
  [   0,-32,  20, CYAN,   6, 0.0005],
  [  -4, -8,   9, YELLOW, 3, 0.0012],
  [   4, -8,  10, TEAL,   3, 0.0010],
  [ -11,-12,   7, CYAN,   2, 0.0015],
  [  11,-12,   8, TEAL,   2, 0.0013],
  [ -26,-10,  12, YELLOW, 4, 0.0009],
  [  26,-10,  11, CYAN,   4, 0.0009],
];

SPHERES.forEach(([bx, bz, orbitY, color, orbitR, orbitSpeed], i) => {
  const mat  = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(sphGeo, mat);
  mesh.position.set(bx, orbitY - 2, bz);
  scene.add(mesh);
  spheres.push({
    mesh,
    orbitR, orbitSpeed,
    orbitPhase: (i / SPHERES.length) * Math.PI * 2,
    orbitY:     orbitY - 2,
    baseX:      bx,
    baseZ:      bz,
    floatAmp:   0.25 + Math.random() * 0.4,
    floatPhase: Math.random() * Math.PI * 2,
  });
});

// ─── Arc trails (Capital & Knowledge Pipelines) ──────────────────────────────
const arcs = [];

function buildArc(fx, fy, fz, tx, ty, tz, lift, color) {
  const from = new THREE.Vector3(fx, fy, fz);
  const to   = new THREE.Vector3(tx, ty, tz);
  const mid  = from.clone().lerp(to, 0.5);
  mid.y += lift;

  const N   = 64;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t  = i / N;
    const t1 = 1 - t;
    pts.push(new THREE.Vector3(
      t1*t1*fx + 2*t1*t*mid.x + t*t*tx,
      t1*t1*fy + 2*t1*t*mid.y + t*t*ty,
      t1*t1*fz + 2*t1*t*mid.z + t*t*tz,
    ));
  }

  const trailLen = Math.floor(N * 0.32);
  const maxPoints = trailLen + 1;
  const positions = new Float32Array(maxPoints * 3);
  
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setDrawRange(0, 0);

  const mat  = lineMat(color, 0.78);
  const line = new THREE.Line(geom, mat);
  scene.add(line);

  arcs.push({
    line,
    geom,
    posAttr: geom.attributes.position,
    pts,
    progress: Math.random(),
    speed:    0.0018 + Math.random() * 0.0012,
    trailLen,
    maxPoints
  });
}

const ARCS = [
  [-22, 18, -5,   0, 22,-32, 14, CYAN  ],
  [ 22, 20, -5,   0, 22,-32, 12, TEAL  ],
  [-22, 18, -5,  22, 20, -5,  8, YELLOW],
  [ -4, 10, -8, -22, 18, -5,  6, TEAL  ],
  [  4, 10, -8,  22, 20, -5,  6, CYAN  ],
  [ -8, 18,-28,   9, 18,-28,  7, YELLOW],
  [  0, 10, -8,  11, 10,-12,  4, TEAL  ],
  [-11, 10,-12,   0, 10, -8,  4, CYAN  ],
  [-22, 18, -5, -26, 16,-10,  5, CYAN  ],
  [ 22, 20, -5,  26, 14,-10,  5, TEAL  ],
];

ARCS.forEach(d => buildArc(...d));

// ─── Camera keyframe path ────────────────────────────────────────────────────
const CAM_KEYS = [
  { p: [  0,  8,  40], l: [0,  4,   0] },  // 0%   - Hero
  { p: [ -6,  6,  22], l: [0,  8,  -8] },  // 25%  - About / Ecosystem
  { p: [  0, 12,   8], l: [0, 10, -20] },  // 50%  - E-Summit / Bech Ke Dikhao
  { p: [  8,  5,  -4], l: [0,  6, -20] },  // 75%  - EIC Market Terminal
  { p: [  0,  3, -15], l: [0, 14, -32] },  // 100% - Team & Roadmap
];

const _tPos  = new THREE.Vector3();
const _tLook = new THREE.Vector3();
const _aPos  = new THREE.Vector3();
const _aLook = new THREE.Vector3();
const _bPos  = new THREE.Vector3();
const _bLook = new THREE.Vector3();
const camPos  = new THREE.Vector3(0, 8, 40);
const camLook = new THREE.Vector3(0, 4, 0);

function sampleCam(t) {
  const N  = CAM_KEYS.length - 1;
  const fi = Math.min(t * N, N - 0.0001);
  const i  = Math.floor(fi);
  const f  = fi - i;
  const a  = CAM_KEYS[i];
  const b  = CAM_KEYS[i + 1];
  _aPos.set(...a.p); _bPos.set(...b.p);
  _aLook.set(...a.l); _bLook.set(...b.l);
  _tPos.copy(_aPos).lerp(_bPos, f);
  _tLook.copy(_aLook).lerp(_bLook, f);
}

// ─── Scroll state across whole page ──────────────────────────────────────────
let scrollRaw    = 0;
let scrollLerped = 0;

function updateScroll() {
  const totalScroll = document.documentElement.scrollHeight - window.innerHeight;
  if (totalScroll > 0) {
    scrollRaw = Math.min(1, Math.max(0, window.scrollY / totalScroll));
  }
}
window.addEventListener('scroll', updateScroll, { passive: true });
updateScroll();

// ─── Cinematic Intro State ────────────────────────────────────────────────────
let introPlaying = true;
let introStartTime = null;
const INTRO_DURATION = 7.0; // 7 seconds intro camera flythrough
const OUTRO_TRANSITION_DURATION = 2.0; // 2 seconds smooth return to scroll position
let outroStartTime = null;
let introFinished = false;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ─── Static render for reduced-motion ────────────────────────────────────────
if (REDUCED_MOTION) {
  sampleCam(0.15);
  camera.position.copy(_tPos);
  camera.lookAt(_tLook);
  renderer.render(scene, camera);
} else {
  // ─── Animation loop ────────────────────────────────────────────────────────
  let lastTime = 0;
  const LERP   = 0.048;

  function animate(time) {
    requestAnimationFrame(animate);
    const dt = Math.min((time - lastTime) / 16.67, 3);
    lastTime = time;
    const t  = time * 0.001;

    let currentProgress = 0;

    if (introPlaying) {
      if (introStartTime === null) introStartTime = time;
      const elapsed = (time - introStartTime) * 0.001;
      const rawT = Math.min(1.0, elapsed / INTRO_DURATION);
      currentProgress = easeInOutCubic(rawT);

      if (rawT >= 1.0) {
        introPlaying = false;
        outroStartTime = time;
      }
    } else if (!introFinished) {
      // Smoothly transition from 1.0 (end of intro) to actual current scrollRaw
      const elapsedOutro = (time - outroStartTime) * 0.001;
      const outroT = Math.min(1.0, elapsedOutro / OUTRO_TRANSITION_DURATION);
      const easedOutro = easeInOutCubic(outroT);

      currentProgress = THREE.MathUtils.lerp(1.0, scrollRaw, easedOutro);

      if (outroT >= 1.0) {
        introFinished = true;
        scrollLerped = scrollRaw;
      }
    } else {
      // Normal scroll-driven behavior
      scrollLerped += (scrollRaw - scrollLerped) * LERP * dt;
      currentProgress = scrollLerped;
    }

    // Camera positioning based on currentProgress
    sampleCam(currentProgress);
    camPos.lerp(_tPos,  0.055 * dt);
    camLook.lerp(_tLook, 0.055 * dt);
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    // Buildings — ambient float + rotation + depth parallax
    buildings.forEach(b => {
      b.group.position.y = Math.sin(t + b.floatPhase) * b.floatAmp - 2;
      b.group.rotation.y += b.rotSpeed;
      const farFactor = Math.abs(b.baseZ) > 15 ? 0.20 : 0.07;
      b.group.position.z = b.baseZ + currentProgress * 32 * farFactor;
    });

    // Spheres — orbital + float + vertical lift
    spheres.forEach(s => {
      const angle = t * s.orbitSpeed * 1000 + s.orbitPhase;
      s.mesh.position.x = s.baseX + Math.cos(angle) * s.orbitR;
      s.mesh.position.z = s.baseZ + Math.sin(angle) * s.orbitR * 0.45;
      const liftFactor  = s.orbitY > 10 ? 0.14 : 0.08;
      s.mesh.position.y = s.orbitY + Math.sin(t + s.floatPhase) * s.floatAmp
                          + currentProgress * 8 * liftFactor;
    });

    // Arcs — continuous trailing animation
    arcs.forEach(a => {
      a.progress = (a.progress + a.speed) % 1;
      const n    = a.pts.length;
      const head = Math.floor(a.progress * n);
      const tail = Math.max(0, head - a.trailLen);
      const count = head - tail + 1;
      
      const posArr = a.posAttr.array;
      for (let idx = 0; idx < count; idx++) {
        const pt = a.pts[tail + idx];
        posArr[idx * 3]     = pt.x;
        posArr[idx * 3 + 1] = pt.y;
        posArr[idx * 3 + 2] = pt.z;
      }
      
      a.geom.setDrawRange(0, count);
      a.posAttr.needsUpdate = true;
    });

    renderer.render(scene, camera);
  }

  requestAnimationFrame(animate);
}
