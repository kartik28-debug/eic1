/**
 * GamesScene — Cinematic 3D Stock Market City & Game Hub
 * Uses Three.js & GSAP for EIC IIIT Una /games.html
 */

import * as THREE from 'three';
import { gsap } from 'gsap';

// ─── Color constants ───
const COLOR_BG       = 0x03060c;
const COLOR_CYAN     = 0x00e5ff;
const COLOR_TEAL     = 0x00bcd4;
const COLOR_GOLD     = 0xe0c253;
const COLOR_RED      = 0xff3b30;
const COLOR_BUILDING = 0x08101d;

// ─── Company Stock Data Definitions ───
const STOCKS_DATA = [
  { name: 'RELIANCE', change: '+2.43%', isPos: true,  price: '₹2,980.50', pos: [0, 0, 0],     size: [6, 32, 6],   isMain: true },
  { name: 'TCS',      change: '+1.21%', isPos: true,  price: '₹4,120.10', pos: [-16, 0, 8],   size: [4.5, 22, 4.5] },
  { name: 'INFY',     change: '+0.89%', isPos: true,  price: '₹1,850.30', pos: [-10, 0, -12], size: [4, 18, 4] },
  { name: 'HDFC',     change: '-0.52%', isPos: false, price: '₹1,640.00', pos: [-24, 0, -6],  size: [4.8, 20, 4.8] },
  { name: 'ADANI',    change: '+3.12%', isPos: true,  price: '₹3,210.75', pos: [16, 0, 6],    size: [4.8, 24, 4.8] },
  { name: 'ICICI',    change: '-0.73%', isPos: false, price: '₹1,120.40', pos: [24, 0, -8],   size: [4.2, 19, 4.2] },
  { name: 'SBIN',     change: '+1.05%', isPos: true,  price: '₹840.20',   pos: [11, 0, -18],  size: [4, 17, 4] },
];

// ─── Canvas Texture Generator for Stock Panels ───
function createStockTexture(company) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Dark futuristic background
  ctx.fillStyle = '#060d1a';
  ctx.fillRect(0, 0, 512, 512);

  // Border frame
  const strokeCol = company.isPos ? '#00e5ff' : '#ff3b30';
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = 10;
  ctx.strokeRect(6, 6, 500, 500);

  // Inner glow line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, 472, 472);

  // Company Name
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px "Space Grotesk", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(company.name, 256, 100);

  // Price
  ctx.fillStyle = '#8aa2b8';
  ctx.font = '28px "JetBrains Mono", monospace';
  ctx.fillText(company.price, 256, 155);

  // Change Pill
  const pillBg = company.isPos ? 'rgba(0, 229, 255, 0.18)' : 'rgba(255, 59, 48, 0.18)';
  ctx.fillStyle = pillBg;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(140, 185, 232, 54, 27);
  } else {
    ctx.rect(140, 185, 232, 54);
  }
  ctx.fill();
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = strokeCol;
  ctx.font = 'bold 30px "JetBrains Mono", monospace';
  ctx.fillText(company.change, 256, 222);

  // Sparkline Chart
  ctx.beginPath();
  ctx.strokeStyle = strokeCol;
  ctx.lineWidth = 5;
  const points = company.isPos
    ? [[60, 420], [130, 390], [200, 430], [270, 350], [340, 370], [410, 300], [450, 280]]
    : [[60, 300], [130, 330], [200, 310], [270, 390], [340, 370], [410, 430], [450, 440]];

  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.stroke();

  // Chart Gradient Fill
  ctx.lineTo(450, 470);
  ctx.lineTo(60, 470);
  ctx.closePath();
  ctx.fillStyle = company.isPos ? 'rgba(0, 229, 255, 0.12)' : 'rgba(255, 59, 48, 0.12)';
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// ─── Floating Index HUD Panel Texture Generator ───
function createHudTexture(title, value, isPos) {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(6, 13, 26, 0.85)';
  ctx.fillRect(0, 0, 384, 192);

  const col = isPos ? '#00e5ff' : '#ff3b30';
  ctx.strokeStyle = col;
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, 376, 184);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px "Space Grotesk", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, 24, 60);

  ctx.fillStyle = col;
  ctx.font = 'bold 32px "JetBrains Mono", monospace';
  ctx.textAlign = 'right';
  ctx.fillText(value, 360, 60);

  // Sparkline
  ctx.beginPath();
  ctx.strokeStyle = col;
  ctx.lineWidth = 3;
  const pts = isPos
    ? [[30, 140], [100, 150], [170, 120], [240, 130], [310, 95], [350, 90]]
    : [[30, 95], [100, 110], [170, 100], [240, 140], [310, 135], [350, 155]];
  ctx.moveTo(pts[0][0], pts[0][1]);
  pts.forEach(p => ctx.lineTo(p[0], p[1]));
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function initGamesScene() {
  const canvas = document.getElementById('games-canvas');
  if (!canvas) return;

  // ─── Renderer ───
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(COLOR_BG, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  // ─── Scene & Camera ───
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(COLOR_BG, 0.015);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 400);

  // Camera animation target points
  const camTarget = new THREE.Vector3(0, 12, 0);

  // ─── Lights ───
  const ambientLight = new THREE.AmbientLight(0x0a1628, 1.5);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0x00e5ff, 2.5);
  dirLight.position.set(20, 50, 20);
  scene.add(dirLight);

  const pointLightCenter = new THREE.PointLight(COLOR_CYAN, 4, 60);
  pointLightCenter.position.set(0, 20, 0);
  scene.add(pointLightCenter);

  // ─── Grid Floor & Dark Reflection Plane ───
  const grid = new THREE.GridHelper(300, 100, 0x00e5ff, 0x0a2035);
  grid.position.y = -0.1;
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  scene.add(grid);

  const floorGeo = new THREE.PlaneGeometry(300, 300);
  const floorMat = new THREE.MeshBasicMaterial({ color: 0x020408 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.2;
  scene.add(floor);

  // ─── Building Generation ───
  const buildingMeshes = [];

  STOCKS_DATA.forEach((stock) => {
    const [w, h, d] = stock.size;
    const [x, , z] = stock.pos;

    const group = new THREE.Group();
    group.position.set(x, 0, z);

    // Dark solid building body
    const bodyGeo = new THREE.BoxGeometry(w, h, d);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: COLOR_BUILDING,
      roughness: 0.2,
      metalness: 0.8,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = h / 2;
    group.add(body);

    // Glowing wireframe edges
    const edgesGeo = new THREE.EdgesGeometry(bodyGeo);
    const edgeColor = stock.isPos ? COLOR_CYAN : COLOR_RED;
    const edgeMat = new THREE.LineBasicMaterial({
      color: edgeColor,
      transparent: true,
      opacity: stock.isMain ? 0.9 : 0.6,
    });
    const edges = new THREE.LineSegments(edgesGeo, edgeMat);
    edges.position.y = h / 2;
    group.add(edges);

    // Front Stock Sign/Panel
    const texture = createStockTexture(stock);
    const panelW = w * 0.88;
    const panelH = panelW;
    const panelGeo = new THREE.PlaneGeometry(panelW, panelH);
    const panelMat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const panelFront = new THREE.Mesh(panelGeo, panelMat);
    panelFront.position.set(0, h * 0.65, d / 2 + 0.05);
    group.add(panelFront);

    // Back Panel
    const panelBack = panelFront.clone();
    panelBack.position.set(0, h * 0.65, -d / 2 - 0.05);
    panelBack.rotation.y = Math.PI;
    group.add(panelBack);

    // Roof Spire/Beacon
    const spireH = stock.isMain ? 10 : 5;
    const spireGeo = new THREE.CylinderGeometry(0.05, 0.2, spireH, 6);
    const spireMat = new THREE.MeshBasicMaterial({ color: edgeColor });
    const spire = new THREE.Mesh(spireGeo, spireMat);
    spire.position.y = h + spireH / 2;
    group.add(spire);

    // Vertical Laser Light Beam
    if (stock.isMain || stock.name === 'ADANI' || stock.name === 'TCS') {
      const beamGeo = new THREE.CylinderGeometry(0.1, 0.8, 120, 16, 1, true);
      const beamMat = new THREE.MeshBasicMaterial({
        color: edgeColor,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.y = h + 60;
      group.add(beam);
    }

    scene.add(group);
    buildingMeshes.push(group);
  });

  // ─── Background Skyline (Fill Buildings) ───
  const bgCount = 40;
  for (let i = 0; i < bgCount; i++) {
    const bw = 3 + Math.random() * 4;
    const bh = 10 + Math.random() * 25;
    const bd = 3 + Math.random() * 4;
    const bx = (Math.random() - 0.5) * 160;
    const bz = -30 - Math.random() * 80;

    const bGeo = new THREE.BoxGeometry(bw, bh, bd);
    const bMat = new THREE.MeshStandardMaterial({
      color: 0x050a14,
      roughness: 0.5,
    });
    const bMesh = new THREE.Mesh(bGeo, bMat);
    bMesh.position.set(bx, bh / 2, bz);

    const bEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(bGeo),
      new THREE.LineBasicMaterial({ color: COLOR_TEAL, transparent: true, opacity: 0.25 })
    );
    bMesh.add(bEdges);
    scene.add(bMesh);
  }

  // ─── Curved Glowing Highways / Financial Streams ───
  const curvePoints1 = [
    new THREE.Vector3(-35, 2, 25),
    new THREE.Vector3(-20, 6, 8),
    new THREE.Vector3(0, 16, -2),
    new THREE.Vector3(20, 8, 8),
    new THREE.Vector3(35, 3, 25),
  ];
  const curve1 = new THREE.CatmullRomCurve3(curvePoints1);
  const tubeGeo1 = new THREE.TubeGeometry(curve1, 80, 0.25, 8, false);
  const tubeMat1 = new THREE.MeshBasicMaterial({
    color: COLOR_CYAN,
    transparent: true,
    opacity: 0.8,
  });
  const tube1 = new THREE.Mesh(tubeGeo1, tubeMat1);
  scene.add(tube1);

  const curvePoints2 = [
    new THREE.Vector3(-30, 4, -20),
    new THREE.Vector3(-10, 12, -8),
    new THREE.Vector3(0, 18, 5),
    new THREE.Vector3(15, 10, -10),
    new THREE.Vector3(30, 3, -25),
  ];
  const curve2 = new THREE.CatmullRomCurve3(curvePoints2);
  const tubeGeo2 = new THREE.TubeGeometry(curve2, 80, 0.2, 8, false);
  const tubeMat2 = new THREE.MeshBasicMaterial({
    color: COLOR_TEAL,
    transparent: true,
    opacity: 0.7,
  });
  const tube2 = new THREE.Mesh(tubeGeo2, tubeMat2);
  scene.add(tube2);

  // ─── Floating HUD Index Panels (NIFTY 50 & SENSEX) ───
  const niftyTex = createHudTexture('NIFTY 50', '+1.34%', true);
  const niftyGeo = new THREE.PlaneGeometry(8, 4);
  const niftyMat = new THREE.MeshBasicMaterial({ map: niftyTex, transparent: true, side: THREE.DoubleSide });
  const niftyMesh = new THREE.Mesh(niftyGeo, niftyMat);
  niftyMesh.position.set(14, 22, 5);
  niftyMesh.rotation.y = -0.3;
  scene.add(niftyMesh);

  const sensexTex = createHudTexture('SENSEX', '+1.29%', true);
  const sensexGeo = new THREE.PlaneGeometry(8, 4);
  const sensexMat = new THREE.MeshBasicMaterial({ map: sensexTex, transparent: true, side: THREE.DoubleSide });
  const sensexMesh = new THREE.Mesh(sensexGeo, sensexMat);
  sensexMesh.position.set(-14, 20, 8);
  sensexMesh.rotation.y = 0.35;
  scene.add(sensexMesh);

  // ─── Floating Particles Field ───
  const particleCount = 250;
  const particleGeo = new THREE.BufferGeometry();
  const particlePos = new Float32Array(particleCount * 3);

  for (let i = 0; i < particleCount * 3; i += 3) {
    particlePos[i]     = (Math.random() - 0.5) * 120;
    particlePos[i + 1] = Math.random() * 50;
    particlePos[i + 2] = (Math.random() - 0.5) * 120;
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
  const particleMat = new THREE.PointsMaterial({
    color: COLOR_CYAN,
    size: 0.35,
    transparent: true,
    opacity: 0.75,
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  scene.add(particles);

  // ─── Floating 3D Candlestick Holograms ───
  const candleGroup = new THREE.Group();
  for (let i = 0; i < 12; i++) {
    const isGreen = Math.random() > 0.3;
    const h = 1.5 + Math.random() * 3.5;
    const cGeo = new THREE.BoxGeometry(0.6, h, 0.6);
    const cMat = new THREE.MeshBasicMaterial({
      color: isGreen ? COLOR_CYAN : COLOR_RED,
      transparent: true,
      opacity: 0.8,
    });
    const candle = new THREE.Mesh(cGeo, cMat);
    const cx = (Math.random() - 0.5) * 35;
    const cy = 6 + Math.random() * 20;
    const cz = (Math.random() - 0.5) * 35;
    candle.position.set(cx, cy, cz);
    candleGroup.add(candle);
  }
  scene.add(candleGroup);

  // ─── ANIMATION & STATE MACHINE ───
  let state = 'INTRO'; // 'INTRO' -> 'INTRO_COMPLETE' -> 'SCROLL_CONTROLLED'
  let scrollProgress = 0;

  // Camera initial position for Intro
  camera.position.set(0, 55, 95);
  camera.lookAt(camTarget);

  // Intro overlay DOM element
  const introBanner = document.getElementById('intro-banner');
  const scrollPrompt = document.getElementById('scroll-prompt');

  // GSAP Intro Timeline
  const introTl = gsap.timeline({
    onComplete: () => {
      state = 'SCROLL_CONTROLLED';
      document.body.classList.add('intro-complete');
      if (scrollPrompt) {
        scrollPrompt.style.opacity = '1';
      }
    },
  });

  introTl
    .to(camera.position, {
      x: 18,
      y: 30,
      z: 55,
      duration: 2.2,
      ease: 'power2.inOut',
      onUpdate: () => camera.lookAt(camTarget),
    })
    .to(camera.position, {
      x: 0,
      y: 14,
      z: 32,
      duration: 2.3,
      ease: 'power2.out',
      onUpdate: () => camera.lookAt(camTarget),
    }, '-=0.4');

  // Fade intro banner slightly as camera finishes
  if (introBanner) {
    introTl.to(introBanner, { opacity: 0.85, duration: 1 }, 1.5);
  }

  // ─── Scroll Handling ───
  function onScroll() {
    if (state !== 'SCROLL_CONTROLLED') return;

    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxScroll <= 0) return;

    scrollProgress = Math.min(Math.max(window.scrollY / maxScroll, 0), 1);
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  // ─── Camera Path Interpolation based on Scroll Progress ───
  // Keyframe targets along scroll (0.0 to 1.0)
  const scrollCamPath = [
    { progress: 0.0, pos: new THREE.Vector3(0, 14, 32),   look: new THREE.Vector3(0, 12, 0) },
    { progress: 0.25, pos: new THREE.Vector3(-12, 10, 22), look: new THREE.Vector3(-10, 10, -5) },
    { progress: 0.50, pos: new THREE.Vector3(0, 16, 12),   look: new THREE.Vector3(0, 14, -2) },
    { progress: 0.75, pos: new THREE.Vector3(14, 12, -2),  look: new THREE.Vector3(0, 8, -15) },
    { progress: 1.0,  pos: new THREE.Vector3(0, 8, -22),   look: new THREE.Vector3(0, 6, -45) },
  ];

  const currentCamPos = new THREE.Vector3();
  const currentCamLook = new THREE.Vector3();

  function updateCameraScroll() {
    if (state !== 'SCROLL_CONTROLLED') return;

    // Find bounding keyframes for scrollProgress
    let p1 = scrollCamPath[0];
    let p2 = scrollCamPath[scrollCamPath.length - 1];

    for (let i = 0; i < scrollCamPath.length - 1; i++) {
      if (scrollProgress >= scrollCamPath[i].progress && scrollProgress <= scrollCamPath[i + 1].progress) {
        p1 = scrollCamPath[i];
        p2 = scrollCamPath[i + 1];
        break;
      }
    }

    const range = p2.progress - p1.progress;
    const factor = range > 0 ? (scrollProgress - p1.progress) / range : 0;

    // Smooth lerp camera position and lookAt target
    currentCamPos.lerpVectors(p1.pos, p2.pos, factor);
    currentCamLook.lerpVectors(p1.look, p2.look, factor);

    camera.position.lerp(currentCamPos, 0.08);
    camTarget.lerp(currentCamLook, 0.08);
    camera.lookAt(camTarget);
  }

  // ─── Resize Handler ───
  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  window.addEventListener('resize', onResize);

  // ─── Render Loop ───
  let clock = new THREE.Clock();

  function animate() {
    requestAnimationFrame(animate);

    const elapsedTime = clock.getElapsedTime();

    // Floating animation for HUD panels
    niftyMesh.position.y = 22 + Math.sin(elapsedTime * 1.5) * 0.4;
    sensexMesh.position.y = 20 + Math.cos(elapsedTime * 1.3) * 0.4;

    // Particle slow drift
    particles.rotation.y = elapsedTime * 0.03;

    // Candlesticks subtle rotation & bobbing
    candleGroup.children.forEach((c, idx) => {
      c.position.y += Math.sin(elapsedTime * 2 + idx) * 0.005;
    });

    // Update camera position if in scroll mode
    updateCameraScroll();

    renderer.render(scene, camera);
  }

  animate();
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGamesScene);
} else {
  initGamesScene();
}
