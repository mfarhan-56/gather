// Gather dashboard: first-person 3D office (presentation only).
// - Three.js is loaded lazily, only when the dashboard is shown.
// - Native page scroll drives the camera between desk objects ("stations").
// - All dashboard data stays in the existing HTML panels rendered by app.js.
// - Falls back to the plain layout on small screens, without WebGL, or with reduced motion (static view).

const view = document.getElementById("view-home");
const canvas = document.getElementById("officeCanvas");
const nav = document.getElementById("stationNav");
const cue = document.getElementById("scrollCue");
const stationsEl = [...document.querySelectorAll("#view-home .station")];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const MIN_WIDTH = 980;

// Camera framing per station: [position, lookAt]. Panels sit on the opposite side of each object.
// Text alternates sides (see .station-left / .station-right); each object is framed on the opposite side.
const SHOTS = {
  desk:     [[0.00, 1.50, 1.95], [-0.25, 0.80, -0.40]],  // text left  -> desk right
  overview: [[-0.50, 1.40, 0.62], [-0.76, 0.74, -0.12]], // text left  -> paper right
  planner:  [[0.34, 1.40, 0.72], [0.54, 0.75, 0.00]],    // text right -> planner left
  monitor:  [[0.22, 1.24, 0.40], [-0.02, 1.00, -0.72]],  // text left  -> monitor right
  tray:     [[-1.02, 1.38, 0.30], [-0.62, 0.80, -0.58]], // text right -> tray left
  notes:    [[0.94, 1.38, 0.38], [0.68, 0.84, -0.50]],   // text left  -> calendar right
};

let THREE, renderer, scene, camera, ready = false, failed = false;
let animating = false;
let targetF = 0, currentF = 0, lastT = 0, introStart = 0;
let pathKey = "", posCurve = null, lookCurve = null;
const INTRO_MS = 1800;

// ---------------------------------------------------------------- helpers
const visibleStations = () => stationsEl.filter((s) => !s.hidden);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

function mode() {
  if (failed || window.innerWidth < MIN_WIDTH) return "flat";
  return reduceMotion.matches ? "static" : "cinematic";
}
function applyMode() {
  const m = mode();
  view.classList.toggle("office-on", m !== "flat");
  view.classList.toggle("office-static", m === "static");
  return m;
}

// Hide a station when every dashboard widget inside it is switched off in Settings.
function syncStationVisibility() {
  let changed = false;
  for (const st of stationsEl) {
    // the due banner is often hidden simply because nothing is due; it never decides the station
    const widgets = [...st.querySelectorAll("[data-widget]")].filter((w) => w.id !== "dueBanner");
    const hide = widgets.length > 0 && widgets.every((w) => w.hidden);
    if (st.hidden !== hide) { st.hidden = hide; changed = true; } // only touch on change (avoids observer loops)
  }
  if (changed || !nav.children.length) buildNav();
}

function buildNav() {
  const list = visibleStations();
  nav.innerHTML = list.map((s, i) =>
    `<button type="button" data-go="${i}"><span>${s.dataset.label}</span><i></i></button>`).join("");
  nav.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    const st = visibleStations()[+b.dataset.go];
    if (st) view.scrollTo({ top: st.offsetTop, behavior: reduceMotion.matches ? "auto" : "smooth" });
  }));
  updateFromScroll();
}

// Fractional station index from scroll: holds on each station, eases between them.
function stationProgress() {
  const list = visibleStations();
  if (!list.length) return { list, f: 0 };
  const mid = view.scrollTop + view.clientHeight * 0.5;
  const centers = list.map((s) => s.offsetTop + s.offsetHeight * 0.5);
  if (mid <= centers[0]) return { list, f: 0 };
  for (let i = 0; i < centers.length - 1; i++) {
    if (mid <= centers[i + 1]) {
      const raw = (mid - centers[i]) / (centers[i + 1] - centers[i]);
      return { list, f: i + raw };
    }
  }
  return { list, f: centers.length - 1 };
}

function updateFromScroll() {
  const { list, f } = stationProgress();
  const active = Math.round(f);
  const cur = list[active];
  if (cur) view.dataset.side = cur.classList.contains("station-right") ? "right" : "left";
  nav.querySelectorAll("button").forEach((b, i) => b.classList.toggle("active", i === active));
  list.forEach((s, i) => s.classList.toggle("in-focus", Math.abs(f - i) < 0.42));
  cue.classList.toggle("gone", view.scrollTop > 40);
  if (!ready || !list.length) return;
  rebuildPath(list);
  targetF = mode() === "cinematic" ? f : 0;
  kick();
}

// One smooth spline through the visible stations (no corners at each object).
function rebuildPath(list) {
  const key = list.map((s) => s.dataset.station).join(",");
  if (key === pathKey && posCurve) return;
  pathKey = key;
  const shots = list.map((s) => SHOTS[s.dataset.station] || SHOTS.desk);
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const pts = shots.map((x) => V(x[0])), looks = shots.map((x) => V(x[1]));
  if (pts.length === 1) { pts.push(pts[0].clone()); looks.push(looks[0].clone()); }
  posCurve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  lookCurve = new THREE.CatmullRomCurve3(looks, false, "centripetal");
  currentF = Math.min(currentF, pts.length - 1);
}

// gentle slow-down near each station without stopping (no "sticky" hold)
function easeSegments(f) {
  const i = Math.floor(f), t = f - i;
  const s = t * t * (3 - 2 * t);
  return i + (t + (s - t) * 0.55);
}

function kick() {
  if (animating || !ready) return;
  animating = true;
  lastT = performance.now();
  requestAnimationFrame(tick);
}

const _p = { x: 0, y: 0, z: 0 };
function tick(now) {
  if (view.hidden || !posCurve) { animating = false; return; }
  const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
  lastT = now;
  // frame-rate independent critically-damped follow of the scroll position
  const k = 1 - Math.exp(-dt * 4.2);
  currentF += (targetF - currentF) * k;
  if (Math.abs(targetF - currentF) < 0.0004) currentF = targetF;

  const n = posCurve.points.length - 1;
  const u = n > 0 ? Math.min(1, Math.max(0, easeSegments(currentF) / n)) : 0;
  const pos = posCurve.getPoint(u), look = lookCurve.getPoint(u);

  // arrival: drift in from slightly behind and above on first load
  const ip = Math.min(1, (now - introStart) / INTRO_MS);
  const ie = 1 - Math.pow(1 - ip, 3);
  const intro = mode() === "cinematic" ? 1 - ie : 0;
  camera.position.set(pos.x, pos.y + 0.22 * intro, pos.z + 0.55 * intro);
  camera.lookAt(look.x, look.y, look.z);
  renderer.render(scene, camera);

  if (currentF !== targetF || ip < 1) requestAnimationFrame(tick);
  else animating = false;
}

// ---------------------------------------------------------------- procedural textures
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

function woodTex(base, dark, seed = 7, planks = 1) {
  return canvasTex(512, 512, (g, w, h) => {
    const r = rng(seed);
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    const ph = h / planks;
    for (let p = 0; p < planks; p++) {
      for (let i = 0; i < 70; i++) {
        g.strokeStyle = dark; g.globalAlpha = 0.05 + r() * 0.12; g.lineWidth = 0.6 + r() * 2.2;
        const y = p * ph + r() * ph;
        g.beginPath(); g.moveTo(0, y);
        for (let x = 0; x <= w; x += 32) g.lineTo(x, y + Math.sin(x * 0.01 + i) * (2 + r() * 4));
        g.stroke();
      }
      if (planks > 1) { g.globalAlpha = 0.5; g.fillStyle = "#120c08"; g.fillRect(0, p * ph, w, 2); }
    }
    g.globalAlpha = 1;
  });
}
function paperTex(lines = 18, heading = true, hand = false) {
  return canvasTex(512, 700, (g, w, h) => {
    g.fillStyle = "#f3eee4"; g.fillRect(0, 0, w, h);
    const r = rng(lines * 13 + (hand ? 5 : 1));
    if (heading) { g.fillStyle = "#2b2a33"; g.globalAlpha = 0.8; g.fillRect(48, 56, 260, 18); g.globalAlpha = 0.35; g.fillRect(48, 86, 180, 10); }
    for (let i = 0; i < lines; i++) {
      const y = 140 + i * 30;
      g.globalAlpha = 0.18 + r() * 0.12;
      g.fillStyle = hand ? "#1d3a8a" : "#2b2a33";
      g.fillRect(48, y, 120 + r() * (w - 200), hand ? 3 : 7);
    }
    g.globalAlpha = 0.9; g.strokeStyle = "#8b7cff"; g.lineWidth = 4; // a touch of Gather violet
    g.beginPath(); g.moveTo(48, 118); g.lineTo(140, 118); g.stroke();
    g.globalAlpha = 1;
  });
}
function screenTex() {
  return canvasTex(1024, 600, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, w, h);
    grd.addColorStop(0, "#0d0f1c"); grd.addColorStop(1, "#151230");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.fillStyle = "#8b7cff"; g.globalAlpha = 0.9; g.fillRect(40, 40, 160, 18);
    g.globalAlpha = 0.35; g.fillStyle = "#e8e9f1"; g.fillRect(40, 72, 260, 10);
    const r = rng(42);
    for (let i = 0; i < 6; i++) { // timeline rows
      const y = 130 + i * 70;
      g.globalAlpha = 0.12; g.fillStyle = "#ffffff"; g.fillRect(40, y, w - 80, 54);
      g.globalAlpha = 0.9; g.fillStyle = i < 2 ? "#f87171" : i < 3 ? "#fbbf24" : "#3ad6e8"; g.fillRect(52, y + 12, 30, 30);
      g.globalAlpha = 0.45; g.fillStyle = "#e8e9f1"; g.fillRect(100, y + 16, 200 + r() * 400, 9); g.fillRect(100, y + 32, 120 + r() * 200, 6);
    }
    g.globalAlpha = 1;
  });
}
function skyTex() {
  return canvasTex(1024, 512, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#070814"); grd.addColorStop(0.6, "#1b1640"); grd.addColorStop(1, "#3a2a55");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    const r = rng(99);
    for (let i = 0; i < 46; i++) { // skyline
      const bw = 18 + r() * 46, bh = 60 + r() * 260, x = r() * w;
      g.fillStyle = `rgba(${10 + r() * 20},${10 + r() * 15},${30 + r() * 30},1)`;
      g.fillRect(x, h - bh, bw, bh);
      for (let k = 0; k < bh / 12; k++) for (let m = 0; m < bw / 9; m++) {
        if (r() < 0.22) { g.fillStyle = r() < 0.5 ? "rgba(255,200,120,0.75)" : "rgba(140,200,255,0.55)"; g.fillRect(x + 3 + m * 9, h - bh + 6 + k * 12, 4, 5); }
      }
    }
    for (let i = 0; i < 70; i++) { g.fillStyle = "rgba(255,255,255,0.6)"; g.fillRect(r() * w, r() * h * 0.45, 1.5, 1.5); }
  });
}
function calendarTex() {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = "#f3eee4"; g.fillRect(0, 0, w, h);
    g.fillStyle = "#8b7cff"; g.fillRect(0, 0, w, 120);
    const d = new Date();
    g.fillStyle = "#ffffff"; g.font = "600 56px Georgia, serif"; g.textAlign = "center";
    g.fillText(d.toLocaleDateString([], { month: "long" }).toUpperCase(), w / 2, 82);
    g.fillStyle = "#2b2a33"; g.font = "600 220px Georgia, serif";
    g.fillText(String(d.getDate()), w / 2, 370);
    g.font = "500 44px Georgia, serif"; g.globalAlpha = 0.6;
    g.fillText(d.toLocaleDateString([], { weekday: "long" }), w / 2, 450);
  });
}

// ---------------------------------------------------------------- scene
function buildScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080d);
  scene.fog = new THREE.Fog(0x07080d, 3.2, 8.5);
  camera = new THREE.PerspectiveCamera(42, 1, 0.05, 30);

  const std = (o) => new THREE.MeshStandardMaterial(o);
  const bg = (o) => new THREE.MeshLambertMaterial({ color: o.color, map: o.map }); // big, mostly-dark surfaces
  const add = (geo, mat, pos, rot, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    if (rot) m.rotation.set(...rot);
    m.castShadow = shadow; m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

  // room
  add(new THREE.PlaneGeometry(14, 14), bg({ map: woodTex("#3a2618", "#120a05", 3, 8), roughness: 0.8 }), [0, 0, 0], [-Math.PI / 2, 0, 0], false);
  const wallMat = bg({ color: 0x1b1a24, roughness: 0.95 });
  add(new THREE.PlaneGeometry(14, 5), wallMat, [0, 2.5, -2.4], null, false);
  add(new THREE.PlaneGeometry(10, 5), wallMat, [-3.2, 2.5, 0], [0, Math.PI / 2, 0], false);
  add(new THREE.PlaneGeometry(10, 5), wallMat, [3.2, 2.5, 0], [0, -Math.PI / 2, 0], false);
  // window with night city
  add(new THREE.PlaneGeometry(3.4, 1.7), new THREE.MeshBasicMaterial({ map: skyTex() }), [0.3, 1.95, -2.38], null, false);
  const frame = std({ color: 0x0c0c12, roughness: 0.6, metalness: 0.4 });
  for (const [w, h, x, y] of [[3.5, 0.06, 0.3, 2.82], [3.5, 0.06, 0.3, 1.08], [0.06, 1.8, -1.42, 1.95], [0.06, 1.8, 2.02, 1.95], [0.04, 1.75, 0.3, 1.95]])
    add(box(w, h, 0.06), frame, [x, y, -2.36], null, false);
  // bookshelf (left) and plant (right) for depth
  const shelfMat = bg({ map: woodTex("#2a1b12", "#0d0805", 11), roughness: 0.7 });
  add(box(0.9, 2.2, 0.36), shelfMat, [-2.4, 1.1, -1.9]);
  const bookColors = [0x5b3a8c, 0x2d5a6b, 0x7a3b2e, 0x3a3a48, 0x8b6a2e, 0x274b3a];
  for (let s = 0; s < 4; s++) for (let b = 0; b < 9; b++)
    add(box(0.07, 0.3 + ((b * 7 + s) % 4) * 0.03, 0.24), bg({ color: bookColors[(b + s) % 6], roughness: 0.8 }), [-2.78 + b * 0.085, 0.38 + s * 0.5, -1.82]);
  add(new THREE.CylinderGeometry(0.16, 0.12, 0.38, 24), std({ color: 0x2b2a33, roughness: 0.6 }), [2.4, 0.19, -1.6]);
  for (let i = 0; i < 9; i++) {
    const leaf = add(new THREE.SphereGeometry(0.14, 12, 10), std({ color: 0x1f4a33, roughness: 0.9 }), [2.4 + Math.sin(i * 2.1) * 0.16, 0.55 + i * 0.07, -1.6 + Math.cos(i * 2.1) * 0.16]);
    leaf.scale.set(1, 1.6, 0.6); leaf.rotation.set(0.4 * Math.sin(i), i, 0);
  }

  // desk
  const deskTop = std({ map: woodTex("#5a3a22", "#1d1108", 5), roughness: 0.45, metalness: 0.05 });
  add(box(2.4, 0.05, 1.2), deskTop, [0, 0.725, -0.3]);
  const leg = std({ color: 0x111116, roughness: 0.4, metalness: 0.7 });
  for (const [x, z] of [[-1.12, -0.82], [1.12, -0.82], [-1.12, 0.22], [1.12, 0.22]]) add(box(0.05, 0.7, 0.05), leg, [x, 0.35, z]);

  // monitor (station: deadlines)
  const screenMat = new THREE.MeshStandardMaterial({ map: screenTex(), emissive: 0xffffff, emissiveMap: null, emissiveIntensity: 0.0, roughness: 0.3 });
  screenMat.emissiveMap = screenMat.map; screenMat.emissiveIntensity = 0.85;
  add(box(0.86, 0.52, 0.03), std({ color: 0x0b0b10, roughness: 0.35, metalness: 0.6 }), [0.38, 1.06, -0.72]);
  add(new THREE.PlaneGeometry(0.82, 0.48), screenMat, [0.38, 1.06, -0.703], null, false);
  add(box(0.06, 0.26, 0.06), leg, [0.38, 0.87, -0.76]);
  add(box(0.3, 0.015, 0.2), leg, [0.38, 0.755, -0.74]);
  add(box(0.5, 0.02, 0.16), std({ color: 0x1a1a22, roughness: 0.5 }), [0.38, 0.76, -0.35]); // keyboard
  add(new THREE.CapsuleGeometry(0.025, 0.04, 6, 12), std({ color: 0x1a1a22, roughness: 0.4 }), [0.75, 0.765, -0.33], [Math.PI / 2, 0, 0]);

  // overview paper (station: briefing)
  add(box(0.3, 0.003, 0.42), std({ map: paperTex(16, true), roughness: 0.9 }), [-0.42, 0.752, -0.12], [0, 0.18, 0]);
  add(box(0.3, 0.003, 0.42), std({ color: 0xe9e3d6, roughness: 0.9 }), [-0.45, 0.749, -0.15], [0, 0.05, 0]);
  add(new THREE.CylinderGeometry(0.006, 0.006, 0.15, 12), std({ color: 0x8b7cff, metalness: 0.6, roughness: 0.3 }), [-0.22, 0.758, -0.05], [Math.PI / 2, 0, 0.9]);

  // planner / diary (station: to do)
  const leather = std({ color: 0x3b2418, roughness: 0.65 });
  add(box(0.46, 0.025, 0.32), leather, [0.22, 0.75, 0.0], [0, -0.12, 0]);
  add(box(0.21, 0.006, 0.3), std({ map: paperTex(12, false, true), roughness: 0.9 }), [0.115, 0.766, 0.012], [0, -0.12, 0.02]);
  add(box(0.21, 0.006, 0.3), std({ map: paperTex(10, true, true), roughness: 0.9 }), [0.33, 0.766, -0.014], [0, -0.12, -0.02]);
  add(box(0.008, 0.004, 0.32), std({ color: 0x8b7cff, roughness: 0.5 }), [0.24, 0.772, 0.0], [0, -0.12, 0]); // ribbon
  add(new THREE.CylinderGeometry(0.007, 0.007, 0.16, 12), std({ color: 0x0f0f14, metalness: 0.8, roughness: 0.25 }), [0.5, 0.77, 0.08], [Math.PI / 2, 0, -0.5]);

  // document tray (station: done)
  const trayMat = std({ color: 0x23232c, roughness: 0.4, metalness: 0.5 });
  for (let k = 0; k < 2; k++) {
    const y = 0.76 + k * 0.1;
    add(box(0.36, 0.012, 0.28), trayMat, [-0.95, y, -0.58]);
    add(box(0.36, 0.06, 0.01), trayMat, [-0.95, y + 0.03, -0.44]);
    add(box(0.01, 0.06, 0.28), trayMat, [-1.13, y + 0.03, -0.58]);
    add(box(0.01, 0.06, 0.28), trayMat, [-0.77, y + 0.03, -0.58]);
    for (let p = 0; p < 4; p++) add(box(0.3, 0.004, 0.22), std({ color: p % 2 ? 0xefe9dd : 0xe6dfd1, roughness: 0.9 }), [-0.95 + p * 0.004, y + 0.012 + p * 0.005, -0.585], [0, p * 0.04, 0]);
  }
  add(box(0.08, 0.04, 0.003), std({ color: 0x34d399, roughness: 0.6 }), [-0.95, 0.79, -0.433]); // green "done" tab

  // desk calendar + meeting notes (station: meetings)
  const calMat = std({ map: calendarTex(), roughness: 0.85 });
  const tent = add(box(0.24, 0.24, 0.006), calMat, [1.02, 0.85, -0.5], [-0.32, -0.45, 0]);
  add(box(0.24, 0.24, 0.006), std({ color: 0x2b2a33, roughness: 0.7 }), [1.06, 0.85, -0.58], [0.32, -0.45, 0]);
  for (let n = 0; n < 3; n++) add(box(0.1, 0.002, 0.1), std({ color: [0xfde68a, 0xb5f3fa, 0xddd6fe][n], roughness: 0.9 }), [0.82 + n * 0.05, 0.751 + n * 0.002, -0.22 - n * 0.03], [0, n * 0.25, 0]);

  // mug + desk lamp
  add(new THREE.CylinderGeometry(0.045, 0.04, 0.1, 24), std({ color: 0xece7f5, roughness: 0.35 }), [-0.72, 0.8, 0.08]);
  const lampMat = std({ color: 0x15151c, roughness: 0.3, metalness: 0.8 });
  add(new THREE.CylinderGeometry(0.08, 0.09, 0.02, 24), lampMat, [-0.95, 0.76, -0.95 + 0.2]);
  add(new THREE.CylinderGeometry(0.01, 0.01, 0.5, 12), lampMat, [-0.92, 1.0, -0.72], [0, 0, -0.25]);
  add(new THREE.ConeGeometry(0.11, 0.14, 24, 1, true), lampMat, [-0.82, 1.24, -0.62], [0, 0, 0.9]);
  add(new THREE.SphereGeometry(0.025, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffe2b0 }), [-0.79, 1.21, -0.6], null, false);

  // lighting: warm lamp pool, cool window fill, screen glow
  scene.add(new THREE.HemisphereLight(0x6f6aa8, 0x120c08, 0.35));
  const lamp = new THREE.SpotLight(0xffd29a, 9, 4.2, 0.95, 0.55, 1.6);
  lamp.position.set(-0.78, 1.2, -0.58); lamp.target.position.set(-0.1, 0.72, -0.15);
  lamp.castShadow = true; lamp.shadow.mapSize.set(2048, 2048); lamp.shadow.bias = -0.0004; lamp.shadow.radius = 4;
  scene.add(lamp, lamp.target);
  const windowLight = new THREE.DirectionalLight(0x8f9cff, 0.55);
  windowLight.position.set(0.5, 2.6, -2.2); windowLight.target.position.set(0, 0.7, 0);
  windowLight.castShadow = false; // measured: a second shadowed light costs ~6 ms/frame on integrated GPUs
  windowLight.shadow.camera.left = -2; windowLight.shadow.camera.right = 2; windowLight.shadow.camera.top = 2; windowLight.shadow.camera.bottom = -2;
  scene.add(windowLight, windowLight.target);
  const glow = new THREE.PointLight(0x8b7cff, 0.9, 1.6, 2);
  glow.position.set(0.38, 1.05, -0.5);
  scene.add(glow);
  const rim = new THREE.PointLight(0x3ad6e8, 0.6, 3.5, 2);
  rim.position.set(1.6, 1.5, 0.8);
  // (rim light removed: measured cost without visible benefit)
}

// ---------------------------------------------------------------- adaptive quality
// Pick the sharpest render scale that keeps a frame under budget on this GPU (measured, not guessed).
const SCALES = [2, 1.5, 1.25, 1, 0.85, 0.75, 0.65, 0.55];
let scaleIdx = 3;
function frameCost(scale) {
  renderer.setPixelRatio(scale);
  renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
  const gl = renderer.getContext(), px = new Uint8Array(4);
  const p = SHOTS.desk[0], l = SHOTS.desk[1];
  camera.position.set(p[0], p[1], p[2]); camera.lookAt(l[0], l[1], l[2]);
  for (let i = 0; i < 4; i++) { renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
  const samples = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    camera.position.x += i % 2 ? 0.002 : -0.002;
    renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    samples.push(performance.now() - t0);
  }
  samples.sort((x, y) => x - y);
  return samples[4]; // median: robust to one-off hiccups
}
function pickQuality() {
  const BUDGET = 14.5; // ms incl. ~4 ms sync overhead => ~10.5 ms GPU, headroom under 16.7 ms at 60 Hz
  const maxScale = Math.min(window.devicePixelRatio || 1, 2);
  let i = SCALES.findIndex((x) => x <= maxScale);
  try {
    renderer.compile(scene, camera);
    frameCost(1); frameCost(1); // warm-up: shader programs + GPU clock ramp
    while (i < SCALES.length - 1 && frameCost(SCALES[i]) > BUDGET) i++;
  } catch (e) { i = SCALES.indexOf(0.75); }
  scaleIdx = i;
  renderer.setPixelRatio(SCALES[i]);
  view.dataset.renderScale = SCALES[i];
}
function resize() {
  if (!ready) return;
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (posCurve) { animating = false; kick(); }
}

async function init() {
  if (ready || failed) return;
  try {
    THREE = await import("./vendor/three.module.min.js");
    const GQ = new URLSearchParams(location.search).get("gq") || "";
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false; // nothing in the room moves: render shadow maps once
    buildScene();
    renderer.shadowMap.needsUpdate = true;
    if (GQ.includes("dbg")) window.__office = { renderer, scene, camera, THREE }; // measurement hook only
    pickQuality();
    ready = true;
    introStart = performance.now();
    view.classList.add("office-ready");
    resize();
    updateFromScroll();
    currentF = targetF;
    kick();
  } catch (e) {
    console.warn("Gather office scene unavailable, using the standard dashboard layout.", e);
    failed = true;
    applyMode();
  }
}

// ---------------------------------------------------------------- wiring
function onShow() {
  if (view.hidden) return;
  const m = applyMode();
  syncStationVisibility();
  if (m !== "flat") init().then(() => { resize(); updateFromScroll(); });
}
view.addEventListener("scroll", updateFromScroll, { passive: true });
window.addEventListener("resize", () => { applyMode(); resize(); updateFromScroll(); if (!view.hidden && mode() !== "flat") init(); });
reduceMotion.addEventListener?.("change", () => { applyMode(); updateFromScroll(); });
new MutationObserver(onShow).observe(view, { attributes: true, attributeFilter: ["hidden"] });
// Settings toggles hide widgets: keep stations and nav in sync with what renderHome() shows.
new MutationObserver(() => syncStationVisibility())
  .observe(document.getElementById("mgrGrid"), { attributes: true, attributeFilter: ["hidden"], subtree: true });
onShow();
