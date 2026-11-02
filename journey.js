// the hero: her photograph -> into her eye -> the camera that holds everyone's memories -> through its
// lens -> the photograph again. one continuous zoom, in both directions.
//
//   experience/controller.js   the one scalar p and its states, glides, flies, detents
//   experience/input.js        wheel / pinch / drag / tap / keys -> intents
//   experience/portrait.js     the photograph as a displaced plane (2.5D), the eye portal rig
//   experience/camera-world.js the digicam, lit by her room, in the blur of the photograph
//   experience/archive.js      the LCD: memory index, playback, letters, voice notes, and the REC booth
//   experience/post.js         the optics: tunnels, distortion, aberration, bloom, grade, grain
//
// if WebGL is missing (or ?dead=1) the still photo stays and the old page below is the site.
// dev: ?p=0.47 freezes p · ?demo=1 fills the card with placeholders · ?calm=1 reduced motion

import { createController, stateAt, R } from "./experience/controller.js?v=35";
import { createInput } from "./experience/input.js?v=35";
import { createPortrait } from "./experience/portrait.js?v=35";
import { createCameraWorld } from "./experience/camera-world.js?v=35";
import { createArchive } from "./experience/archive.js?v=35";
import { createPost } from "./experience/post.js?v=35";
import { clamp, lerp, smooth, smoother, win, table, loadImage, wait } from "./experience/util.js?v=35";

const journey = document.getElementById("journey");
const pin = journey.querySelector(".journey-pin");
const q = new URLSearchParams(location.search);
const calm = q.has("calm") ? q.get("calm") === "1" : matchMedia("(prefers-reduced-motion: reduce)").matches;
const pinned = q.has("p") ? clamp(parseFloat(q.get("p")) || 0, 0, 0.999) : null;
const coarse = matchMedia("(pointer: coarse)").matches;

try {
  if (q.get("dead") === "1") throw new Error("fallback forced");
  const THREE = await import("three");
  const { RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js");
  const [photoImg, depthImg, stickerImg] = await Promise.all([
    loadImage("assets/kimaya.jpg"),
    loadImage("assets/kimaya-depth.png?v=2"),
    loadImage("assets/sticker.png"),
  ]);
  await Promise.race([
    Promise.all([document.fonts.load('30px "VT323"'), document.fonts.load('italic 26px "Instrument Serif"'), document.fonts.load('600 40px "Caveat"')]).catch(() => {}),
    wait(2000),
  ]);
  init(THREE, RoundedBoxGeometry, photoImg, depthImg, stickerImg);
  journey.classList.remove("dead"); // script.js may have given up on us during a slow load
  journey.classList.add("live");
  journey.classList.toggle("calm", calm);
  journey.classList.toggle("coarse", coarse);
} catch (err) {
  console.warn("[journey] falling back to the still:", err);
  journey.classList.add("dead");
}

function init(THREE, RoundedBoxGeometry, photoImg, depthImg, stickerImg) {
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

  // ---------- renderer, targets, textures ----------

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  if (!renderer.capabilities.isWebGL2) throw new Error("no WebGL2");
  if (!renderer.extensions.has("EXT_color_buffer_float") && !renderer.extensions.has("EXT_color_buffer_half_float")) throw new Error("no float render targets");
  pin.prepend(renderer.domElement);
  const rtP = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const rtC = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });

  const photo = new THREE.Texture(photoImg);
  photo.colorSpace = THREE.SRGBColorSpace;
  photo.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  photo.needsUpdate = true;
  const depth = new THREE.Texture(depthImg);
  depth.generateMipmaps = false;
  depth.minFilter = depth.magFilter = THREE.LinearFilter;
  depth.needsUpdate = true;
  const sticker = new THREE.Texture(stickerImg);
  sticker.colorSpace = THREE.SRGBColorSpace;
  sticker.needsUpdate = true;

  const FOV = 35;
  const T = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  // near/far kept tight: the lens dive ends 0.025 units from the glass, the photo starts ~16 away.
  // a wide range here z-fights the camera's thin layered parts (the LCD over its inset).
  const view = new THREE.PerspectiveCamera(FOV, 1, 0.012, 80);

  // ---------- the parts ----------

  const ctrl = createController({ calm, pinned });
  const portrait = createPortrait(THREE, { photo, depth, fov: FOV });
  let flashT = 0;
  const archive = createArchive(THREE, {
    journey,
    calm,
    demo: q.get("demo") === "1",
    visible: () => ctrl.p >= R.SWAP_EYE && ctrl.p < R.SWAP_LENS,
    onClose: () => { dirty = true; },
    onHome: () => ctrl.back(),
    onFlash: () => { flashT = 1; dirty = true; },
  });
  const world = createCameraWorld(THREE, RoundedBoxGeometry, { photo, sticker, lcd: archive.lcd, renderer });
  const post = createPost(THREE, { tPortrait: rtP.texture, tCamera: rtC.texture, tPhoto: photo });
  post.uniforms.uEyeUv.value.copy(portrait.eyeUv);
  post.uniforms.uIrisR.value = portrait.uniforms.uIrisUv.value;
  post.uniforms.uCalm.value = calm ? 1 : 0;
  portrait.uniforms.uCalm.value = calm ? 1 : 0;

  // dev handles (journey.dev.ctrl.p, journey.dev.archive.A, ...)
  journey.dev = { ctrl, archive, portrait, world, post, view, renderer, draw: (p) => { const k = ctrl.C.p; if (p !== undefined) ctrl.C.p = p; draw(performance.now(), 0, 0); ctrl.C.p = k; }, setScale: (s) => { scale = s; resize(); } };

  // ---------- the optics table: intensities keyed to p ----------
  //         p     aberr dist  bloom grain grade streak tunnel black white expo  liquid fold  split resolve depth
  const optics = table([
    [0.000, 0.08, 0.00, 0.15, 0.035, 0.60, 0.0, 0.0, 0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.300, 0.12, 0.00, 0.20, 0.040, 0.65, 0.0, 0.0, 0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.440, 0.35, 0.15, 0.30, 0.050, 0.80, 0.2, 0.0, 0, 0.0, 1.15, 0.5, 0.0, 0.3, 0.0, 1.4],
    [0.520, 0.60, 0.45, 0.45, 0.060, 0.90, 0.5, 0.0, 0, 0.0, 1.35, 1.0, 0.4, 0.8, 0.0, 1.7],
    [0.550, 0.80, 0.70, 0.55, 0.070, 0.95, 0.7, 0.0, 0, 0.0, 1.45, 1.0, 0.8, 1.0, 0.0, 1.7],
    [0.575, 1.00, 0.90, 0.60, 0.080, 1.00, 0.8, 1.0, 0, 0.0, 1.3, 1.0, 1.0, 1.0, 0.0, 1.7],
    [0.586, 0.90, 0.80, 0.40, 0.080, 1.00, 0.6, 1.0, 0, 0.0, 1.2, 1.0, 1.0, 1.0, 0.0, 1.7],
    [0.594, 0.60, 0.60, 0.20, 0.080, 1.00, 0.3, 1.0, 1, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.7],
    [0.606, 0.50, 0.40, 0.30, 0.070, 0.95, 0.3, 1.0, 1, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.620, 0.40, 0.20, 0.50, 0.060, 0.90, 0.3, 0.6, 0, 0.0, 0.6, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.640, 0.25, 0.05, 0.40, 0.045, 0.75, 0.1, 0.0, 0, 0.0, 0.9, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.660, 0.10, 0.00, 0.35, 0.040, 0.70, 0.0, 0.0, 0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.800, 0.10, 0.00, 0.35, 0.040, 0.70, 0.0, 0.0, 0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.880, 0.40, 0.30, 0.55, 0.050, 0.85, 0.3, 0.0, 0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.920, 0.70, 0.60, 0.70, 0.060, 0.95, 0.6, 0.2, 0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.950, 1.00, 0.90, 0.90, 0.080, 1.00, 1.0, 1.0, 0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.957, 0.80, 0.70, 1.00, 0.080, 1.00, 0.8, 1.0, 0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.972, 0.50, 0.40, 0.60, 0.080, 1.00, 0.5, 1.0, 0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.1],
    [0.985, 0.25, 0.15, 0.30, 0.050, 0.80, 0.1, 0.8, 0, 0.2, 1.0, 0.0, 0.0, 0.0, 0.5, 1.1],
    [1.000, 0.08, 0.00, 0.15, 0.035, 0.60, 0.0, 0.0, 0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.1],
  ]);
  const O = new Array(15);

  // ---------- rigs ----------

  let aspect = 1;
  const fit = (w, h) => Math.max(h / 2 / T, w / 2 / (T * aspect));
  const orbitP = { yaw: 0, pitch: 0 };          // portrait tilt from drag
  const orbitEased = { yaw: 0, pitch: 0 };
  const orbitC = { yaw: 0, pitch: 0 };          // camera spin from drag
  const parallax = { x: 0, y: 0, tx: 0, ty: 0 }; // pointer parallax on the portrait
  Object.assign(journey.dev, { orbitP, orbitC, parallax });
  const ptr = { x: 0, y: 0 };
  const CAM = V3();
  const camPos = V3(), camLook = V3(), lcdPos = V3(), lcdLook = V3(), mixLook = V3(), tmpDir = V3(), tmpAim = V3();

  function heroDist() { return fit(world.size.CW * 1.25, world.size.CH * 2.0); }

  // the camera world's rig: arrive behind the camera (its screen playing), spin round to its lens, dive in
  function cameraPose(p) {
    const hero = heroDist();
    const lensW = world.lensWorld(V3());
    // yaw: pi = from behind. swing to the front over 0.74..0.86
    const swing = smoother(p, 0.74, 0.86);
    const userW = 1 - smooth(p, 0.78, 0.86);
    const yaw = lerp(Math.PI - 0.35, 0, swing) + orbitC.yaw * userW;
    const pitch = lerp(0.18, 0.0, swing) + orbitC.pitch * userW;
    tmpDir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const z0 = smoother(p, 0.60, 0.66);
    let dist = Math.exp(lerp(Math.log(hero * 0.12), Math.log(hero), z0));
    let f = lerp(50, FOV, z0);
    const z1 = smoother(p, 0.66, 0.80);
    dist = Math.exp(lerp(Math.log(dist), Math.log(hero * 0.6), z1));
    tmpAim.copy(CAM).lerp(lensW, smoother(p, 0.80, 0.86));
    const z2 = smoother(p, 0.80, 0.88);
    dist = Math.exp(lerp(Math.log(dist), Math.log(0.95), z2));
    f = lerp(f, 60, smoother(p, 0.80, 0.92));
    const z3 = smoother(p, 0.88, 0.92);
    dist = Math.exp(lerp(Math.log(dist), Math.log(0.26), z3));
    const z4 = smoother(p, 0.92, R.SWAP_LENS);
    dist = Math.exp(lerp(Math.log(dist), Math.log(0.025), z4));
    camPos.copy(tmpAim).addScaledVector(tmpDir, dist);
    camLook.copy(tmpAim);
    return f;
  }

  // the archive: the whole back face-on (its buttons in reach), or on a tall screen just the LCD,
  // which rises while the note form is open underneath it (lift: 0..1, eased in the loop)
  let lift = 0;
  function lcdPose() {
    const lcdW = world.lcdWorld(V3());
    if (aspect < 1) {
      lcdLook.copy(lcdW).setY(lcdW.y - 0.7 * lift);
      lcdPos.copy(lcdLook).add(V3(0, 0, -fit(1.92 * 1.06, 1.44 * 1.06)));
    } else {
      lcdLook.copy(CAM).setY(0.04);
      lcdPos.copy(lcdLook).add(V3(0, 0, -fit(world.size.CW * 1.08, world.size.CH * 1.12)));
    }
  }

  // ---------- input ----------

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const sinceOpen = () => performance.now() - archive.A.since;

  function hitAt(e, objects) {
    const r = pin.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    view.updateMatrixWorld();
    ray.setFromCamera(ndc, view);
    return ray.intersectObjects(objects, false)[0] || null;
  }
  const cameraSide = () => ctrl.p >= R.SWAP_EYE && ctrl.p < R.SWAP_LENS;
  const inCameraWorld = () => ctrl.p >= R.EYE_TRANSITION && ctrl.p < R.CAMERA;

  // the view must hold the pose of the scene being hit; poses are re-set every frame anyway
  function poseForHit() {
    if (cameraSide()) {
      cameraPose(ctrl.p);
      const fe = smoother(archive.A.t, 0, 1);
      if (fe > 0) { lcdPose(); view.position.lerpVectors(camPos, lcdPos, fe); view.lookAt(mixLook.lerpVectors(camLook, lcdLook, fe)); }
      else { view.position.copy(camPos); view.lookAt(camLook); }
    } else {
      portrait.pose(view, ctrl.p, aspect, orbitP, parallax);
    }
  }

  function press(hit) {
    const btn = hit.object;
    const action = btn.userData.action;
    if (action !== "lcd" && action !== "lens") {
      btn.position.z -= 0.012;
      setTimeout(() => { btn.position.z += 0.012; dirty = true; }, 140);
    }
    dirty = true;
    if (archive.isOpen()) {
      if (action === "lcd" || action === "lens") return;
      archive.onAction(action, hit);
      return;
    }
    if (action === "lcd") { archive.open(); return; }
    if (action === "lens") { ctrl.activate(); window.KimayaSound?.cue("charge"); return; }
    if (action === "shutter" || action === "rec") { archive.open(); archive.onAction("shutter"); return; }
    archive.onAction(action, hit);
  }

  // below the hero: the wheel only ever moves the journey. the ↓ on the photograph is the one way
  // down: it unlocks the page and scrolls it, which fades the photograph to black under the title
  // and brings the wish up beneath it. back at the top the page locks again.
  let released = false;
  const below = () => scrollY > 1;
  function release(on) {
    if (released === on) return;
    released = on;
    journey.classList.toggle("released", on);
    document.body.classList.toggle("j-released", on);
  }
  function onScroll() {
    const k = clamp(scrollY / innerHeight, 0, 1);
    journey.style.setProperty("--fade", k.toFixed(3));
    journey.classList.toggle("below", k > 0.02);
    if (k <= 0.001) release(false);
  }
  addEventListener("scroll", onScroll, { passive: true });
  journey.querySelector(".j-down")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (archive.isOpen() || ctrl.flying) return;
    release(true);
    scrollTo({ top: innerHeight, behavior: calm ? "auto" : "smooth" });
  });
  // "record a wish" on the black: back up, dive into the camera, land on the leave-a-memory screen
  let wishPending = false;
  journey.querySelector(".j-wishbtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (archive.isOpen() || pinned !== null) return;
    scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
    wishPending = true;
    ctrl.activate();
    window.KimayaSound?.cue("charge");
  });
  function landWish() {
    if (!wishPending || ctrl.flying || !inCameraWorld() || archive.isOpen()) return;
    wishPending = false;
    archive.open();
    archive.onAction("shutter");
  }

  const input = createInput(pin, {
    passWheel() {
      return !archive.isOpen() && below(); // only while already down: the page scrolls back up
    },
    onNudge(dp, src) {
      if (archive.isOpen() || pinned !== null || below()) return;
      wishPending = false;
      ctrl.nudge(dp * (src === "pinch" ? 1.2 : 1) * (calm ? 0.6 : 1));
      velSrc = src;
      dirty = true;
    },
    onDrag(dx, dy) {
      if (archive.isOpen()) return;
      const k = 1 / Math.max(innerWidth, 600);
      if (!cameraSide()) {
        orbitP.yaw = Math.tanh((orbitP.yaw - dx * k * 1.8) / 0.25) * 0.25;   // ±14°
        orbitP.pitch = Math.tanh((orbitP.pitch + dy * k * 1.2) / 0.16) * 0.16; // ±9°
      } else {
        orbitC.yaw -= dx * k * 5.5;
        orbitC.pitch = clamp(orbitC.pitch + dy * k * 3.0, -0.6, 0.6);
      }
      dirty = true;
    },
    onClick(e) {
      if (below()) { scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" }); return true; }
      poseForHit();
      if (archive.isOpen()) {
        if (archive.A.t < 0.9 || sinceOpen() < 400) return true;
        const hit = hitAt(e, world.buttons);
        if (hit) press(hit);
        return !!hit;
      }
      if (ctrl.flying) return true; // one transition at a time
      if (ctrl.p < R.EYE_APPROACH) {
        const hit = hitAt(e, [portrait.eyeHit]);
        if (hit || (coarse && ctrl.p >= R.PORTRAIT)) { ctrl.activate(); window.KimayaSound?.cue("beep"); return true; }
        return false;
      }
      if (cameraSide() && ctrl.p < R.LENS_APPROACH) {
        const hit = hitAt(e, world.buttons);
        if (hit) press(hit);
        return !!hit;
      }
      return false;
    },
    onDblClick() {
      if (archive.isOpen() || ctrl.flying) return;
      orbitP.yaw = orbitP.pitch = orbitC.yaw = orbitC.pitch = 0;
      ctrl.reset();
      dirty = true;
    },
    onPointer(x, y, e) {
      ptr.x = x;
      ptr.y = y;
      parallax.tx = -x * 0.35;
      parallax.ty = y * 0.2;
      if (cameraSide() && (inCameraWorld() || archive.isOpen())) {
        poseForHit();
        const hit = hitAt(e, world.buttons);
        world.setHover(hit?.object || null);
        pin.style.cursor = hit ? "pointer" : "";
      } else if (ctrl.p < R.EYE_APPROACH) {
        poseForHit();
        pin.style.cursor = hitAt(e, [portrait.eyeHit]) ? "pointer" : "";
        world.setHover(null);
      } else {
        pin.style.cursor = "";
        world.setHover(null);
      }
      dirty = true;
    },
    onKey(e) {
      if (archive.isOpen()) return archive.onKey(e);
      if (e.key === "Escape") { ctrl.back(); return true; }
      if (e.key === "Enter") { ctrl.activate(); return true; }
      if (inCameraWorld()) {
        if (e.key === "ArrowLeft") { archive.step(-1); return true; }
        if (e.key === "ArrowRight") { archive.step(1); return true; }
      }
      return false;
    },
  });
  let velSrc = "wheel";

  journey.querySelector(".j-see")?.addEventListener("click", (e) => { e.stopPropagation(); if (inCameraWorld() && !ctrl.flying) archive.open(); });
  journey.querySelector(".j-leave")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!inCameraWorld() || ctrl.flying) return;
    archive.open();
    archive.onAction("shutter"); // straight to the "leave her a memory" screen
  });
  journey.querySelector(".j-nav-next")?.addEventListener("click", (e) => { e.stopPropagation(); ctrl.activate(); });
  journey.querySelector(".j-nav-back")?.addEventListener("click", (e) => { e.stopPropagation(); if (archive.isOpen()) archive.close(); else ctrl.back(); });

  // ---------- hud + sound ----------

  const hud = {
    zoom: journey.querySelector(".j-zoom i"),
    brackets: journey.querySelector(".j-focus"),
    title: journey.querySelector(".j-title"),
  };
  const sound = { black: null, locked: null, lens: null };
  window.KimayaSound?.configure({ beats: { face: 0.06, eye: 0.44, pupil: 0.595, front: 0.615, lens: 0.965, back: 0.99 } });

  function updateHud(p) {
    const onCameraSide = cameraSide();
    if (hud.zoom) {
      const z = p < R.EYE_TRANSITION ? p / R.EYE_APPROACH : p < R.SWAP_LENS ? (p - R.EYE_TRANSITION) / (R.LENS_APPROACH - R.EYE_TRANSITION) : 0;
      hud.zoom.style.width = `${Math.round(clamp(z, 0, 1) * 100)}%`;
    }
    if (hud.title) hud.title.style.opacity = String(1 - smooth(p, 0.02, 0.22));
    const locked = (p > 0.42 && p < R.EYE_APPROACH) || (p > 0.86 && p < R.LENS_APPROACH);
    if (hud.brackets) {
      hud.brackets.classList.toggle("locked", locked);
      // on the photograph the brackets sit on her eye, the one place that leads somewhere
      const onEye = p < 0.42 && !onCameraSide && isFinite(eyeS.x);
      hud.brackets.classList.toggle("on-eye", onEye);
      hud.brackets.style.left = onEye ? `${(eyeS.x * 100).toFixed(2)}%` : "";
      hud.brackets.style.top = onEye ? `${((1 - eyeS.y) * 100).toFixed(2)}%` : "";
    }
    journey.classList.toggle("in-camera", inCameraWorld() && !archive.isOpen());
    journey.classList.toggle("at-start", p < 0.02 && !archive.isOpen());
    journey.dataset.state = stateAt(p, { archiveOpen: archive.isOpen(), memory: archive.isOpen() && (archive.A.view === "item" || archive.rec.mode !== "play"), interacting: input.dragging() });
    return locked;
  }

  // ---------- frame ----------

  let dirty = true, frameNo = 0, lastT = performance.now();
  const centre = new THREE.Vector2(0.5, 0.5), eyeS = new THREE.Vector2(), lensS = new THREE.Vector2();
  const proj = V3();
  let uZ = 0, lastP = ctrl.p;

  function draw(now, dt, dp) {
    const p = ctrl.p;
    journey.progress = p;
    const onCamera = cameraSide();
    optics(p, O);
    const [aberr, dist, bloom, grain, grade, streak, tunnel, black, white, expo, liquid, fold, split, resolve, amount] = O;
    const vel = clamp(Math.abs(ctrl.vel) / 0.8, 0, 1) * (velSrc === "trackpad" ? 0.6 : 1) * (calm ? 0.35 : 1);
    const fe = smoother(archive.A.t, 0, 1);

    // the photograph
    if (!onCamera) {
      parallax.x += (parallax.tx - parallax.x) * (1 - Math.exp(-dt * 4));
      parallax.y += (parallax.ty - parallax.y) * (1 - Math.exp(-dt * 4));
      const idle = calm ? 0 : 1;
      // the user's tilt and the pointer parallax fade out towards the eye and ease back in after the wrap
      const user = p >= 0.9 ? 0 : smooth(p, 0.0, 0.05) * (1 - smooth(p, 0.3, 0.5));
      const off = { x: (parallax.x + 0.12 * Math.sin(now * 0.00021) * idle) * user, y: (parallax.y + 0.08 * Math.sin(now * 0.00017 + 1) * idle) * user };
      orbitEased.yaw = orbitP.yaw * user;
      orbitEased.pitch = orbitP.pitch * user;
      const orbit = p >= 0.9 ? null : orbitEased;
      portrait.pose(view, p, aspect, orbit, off);
      portrait.uniforms.uAmount.value = amount * (1 + 0.04 * Math.sin(now * 0.0003) * (calm ? 0 : 1));
      portrait.uniforms.uFacet.value = 1;
      portrait.uniforms.uSplit.value = split;
      portrait.uniforms.uFold.value = fold * (calm ? 0.5 : 1);
      portrait.uniforms.uFoldN.value = Math.round(lerp(6, 10, fold));
      portrait.uniforms.uLiquid.value = liquid;
      portrait.tick(now / 1000);
      portrait.eyeScreen(view, eyeS);
      renderer.setRenderTarget(rtP);
      renderer.render(portrait.scene, view);
    }

    // the camera world
    if (onCamera) {
      const f = cameraPose(p);
      if (fe > 0) {
        lcdPose();
        view.position.lerpVectors(camPos, lcdPos, fe);
        view.lookAt(mixLook.lerpVectors(camLook, lcdLook, fe));
      } else {
        view.position.copy(camPos);
        view.lookAt(camLook);
      }
      const fov = lerp(f, FOV, fe);
      if (view.fov !== fov) { view.fov = fov; view.updateProjectionMatrix(); }
      world.glassMat.uniforms.uNear.value = smooth(p, 0.80, 0.93);
      world.flash.material.emissive.setScalar(flashT * 3);
      world.tick(now / 1000);
      proj.copy(world.lensWorld(proj)).project(view);
      lensS.set(proj.x * 0.5 + 0.5, proj.y * 0.5 + 0.5);
      renderer.setRenderTarget(rtC);
      renderer.render(world.scene, view);
    }

    // the optics
    const U = post.uniforms;
    U.uMix.value = onCamera ? 1 : 0;
    U.uTime.value = now / 1000;
    U.uSeed.value = calm ? 0 : frameNo % 3;
    U.uAberr.value = Math.min(1.2, aberr + 0.4 * vel) * (fe > 0 ? 1 - 0.7 * fe : 1);
    U.uVel.value = vel;
    U.uDistort.value = dist * (1 - fe) * (calm ? 0.35 : 1);
    U.uBloom.value = bloom * (fe > 0 ? 1 - 0.5 * fe : 1);
    U.uGrain.value = grain;
    U.uGrade.value = grade;
    U.uStreak.value = (streak + 0.3 * vel) * (1 - fe) * (calm ? 0.35 : 1);
    U.uTunnel.value = tunnel * (1 - fe);
    U.uTunnelMode.value = p >= 0.9 ? 1 : 0;
    U.uFold.value = p >= 0.9 ? 0.9 : 0.8 * (calm ? 0.5 : 1);
    U.uSegments.value = p >= 0.9 ? 8 : Math.round(lerp(8, 12, smooth(p, 0.55, 0.6)));
    U.uBlack.value = black * 0.92;
    U.uWhite.value = white * 0.92;
    U.uExposure.value = expo;
    U.uResolve.value = resolve;
    U.uFlash.value = flashT * 0.85;
    // rings race with zoom, fall towards you on the way in, open outwards after the crossing
    const towards = (p < R.SWAP_EYE || p >= R.LENS_APPROACH) ? 1 : -1;
    uZ += towards * dp * 40 + dt * (calm ? 0.1 : 0.4);
    U.uZ.value = uZ;
    U.uCenter.value.copy(onCamera ? lensS : eyeS);
    // keep the centre sane when the scene point is off-screen
    const c = U.uCenter.value;
    c.set(clamp(c.x, -0.5, 1.5), clamp(c.y, -0.5, 1.5));
    if (!isFinite(c.x) || !isFinite(c.y)) c.set(0.5, 0.5);
    post.render(renderer);

    flashT = Math.max(0, flashT - 0.25);

    // hud, classes, sound
    const locked = updateHud(p);
    const blackNow = Math.max(black, white);
    window.KimayaSound?.setProgress(calm ? 1 : p, { black: calm ? 0 : blackNow });
    if (blackNow > 0.97 && sound.black === false) window.KimayaSound?.cue("shutter");
    if (locked && sound.locked === false) window.KimayaSound?.cue("beep");
    const lensNow = p >= R.CAMERA && p < R.LENS_APPROACH;
    if (lensNow && sound.lens === false) window.KimayaSound?.cue("charge");
    sound.black = blackNow > 0.97;
    sound.locked = locked;
    sound.lens = lensNow;
  }

  // ---------- sizing, adaptive resolution ----------

  const maxScale = Math.min(devicePixelRatio || 1, 1.25);
  let scale = Math.min(maxScale, coarse ? 0.8 : 1);
  function resize() {
    const w = pin.clientWidth, h = pin.clientHeight;
    if (!w || !h) return;
    const bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale));
    renderer.setPixelRatio(1);
    renderer.setSize(bw, bh, false);
    rtP.setSize(bw, bh);
    rtC.setSize(bw, bh);
    post.resize(bw, bh);
    world.backdrop.material.uniforms.uAspect.value = w / h;
    aspect = w / h;
    view.aspect = aspect;
    view.updateProjectionMatrix();
    portrait.setStart(aspect);
    dirty = true;
  }
  new ResizeObserver(resize).observe(pin);
  resize();

  // ---------- warm-up: compile every path behind the still so the first frames don't stall ----------

  for (const wp of [0.0, 0.56, 0.66, 0.95]) {
    const keep = ctrl.C.p;
    ctrl.C.p = wp;
    draw(performance.now(), 0, 0);
    ctrl.C.p = keep;
  }
  draw(performance.now(), 0, 0);

  // ---------- loop ----------

  let lastBoil = 0, slow = 0, onScreen = true, drewLast = false;
  const born = performance.now();
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(journey);

  (function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - lastT) / 1000, 0.5);
    lastT = now;
    if (!onScreen || document.hidden) return;

    // sustained slow frames: render smaller; sustained fast: claw it back. skip the first seconds,
    // and only judge intervals between two frames that actually drew.
    if (now - born > 2500 && drewLast) {
      slow = dt > 0.045 ? slow + 1 : dt < 0.022 ? slow - 1 : slow;
      if (slow > 4 && scale > 0.35) { scale = Math.max(0.35, scale * 0.7); slow = 0; resize(); }
      else if (slow < -90 && scale < maxScale) { scale = Math.min(maxScale, scale * 1.25); slow = 0; resize(); }
    }

    const { moving, dp } = ctrl.tick(dt, now);
    if (ctrl.C.wrapped) { orbitP.yaw = orbitP.pitch = orbitC.yaw = orbitC.pitch = 0; parallax.x = parallax.y = 0; }
    let blending = archive.tick(dt);
    const liftTo = aspect < 1 && archive.isOpen() && (archive.rec.mode === "review" || archive.rec.mode === "sending") ? 1 : 0;
    if (Math.abs(lift - liftTo) > 1e-3) { lift = calm ? liftTo : lift + (liftTo - lift) * (1 - Math.exp(-dt * 6)); blending = true; }
    else lift = liftTo;
    lastP = ctrl.p;
    landWish();

    // the LCD slideshows by itself while you're just looking at the camera
    if (!calm) archive.autoFlip(now);
    if (archive.live()) { archive.drawLCD(now); dirty = true; }

    const boil = !calm && now - lastBoil > 1000 / 12;
    if (boil) { lastBoil = now; frameNo++; }
    const willDraw = moving || blending || boil || dirty || flashT > 0;
    if (willDraw) {
      dirty = false;
      draw(now, dt, dp);
    }
    drewLast = willDraw;
  })(performance.now());
}
