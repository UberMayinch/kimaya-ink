// scroll journey:
//   kimaya gripping a digicam pointed at us -> she lowers it -> her face -> her eyes ->
//   into the pupil -> (cut) the camera's front, as she sees it -> into its small top lamp ->
//   (cut) out the other side: the camera's back, whose LCD is the gallery. FOCUS to hold it.
//
// one art process for everything: physically lit from afar, and the closer you get the more
// every surface (photo, hand, metal) breaks into facets. facets are anchored to the surface
// and sized by real magnification (screen pixels per 0.01 world units), then one paint pass.

const journey = document.getElementById("journey");
const pin = journey.querySelector(".journey-pin");

try {
  const THREE = await import("three");
  const { RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js");
  const [photo, depth, hand] = await Promise.all([
    loadImage("assets/kimaya.jpg"),
    loadImage("assets/kimaya-depth.png"),
    loadImage("assets/hand.png"),
  ]);
  await document.fonts.load('30px "VT323"').catch(() => {});
  init(THREE, RoundedBoxGeometry, photo, depth, hand);
  journey.classList.add("live");
} catch (err) {
  console.warn("[journey] falling back to still:", err);
  journey.classList.add("dead");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function init(THREE, RoundedBoxGeometry, photoImg, depthImg, handImg) {
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { smootherstep, lerp, clamp } = THREE.MathUtils;
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

  // ---------- photo space: 1600x860 image, 100 px per world unit ----------

  const TEX = new THREE.Vector2(1600, 860);
  const PW = 16, PH = 8.6, DS = 1.6;
  const px = (x, y) => new THREE.Vector2(x / TEX.x, 1 - y / TEX.y);
  const EYE = px(713, 317);
  const FACE = px(650, 430);
  const BETWEEN = px(630, 330);

  const dc = document.createElement("canvas");
  dc.width = depthImg.width;
  dc.height = depthImg.height;
  const dctx = dc.getContext("2d");
  dctx.drawImage(depthImg, 0, 0);
  const dpx = dctx.getImageData(0, 0, dc.width, dc.height).data;
  const depthAt = (uv) => {
    const x = clamp(Math.round(uv.x * (dc.width - 1)), 0, dc.width - 1);
    const y = clamp(Math.round((1 - uv.y) * (dc.height - 1)), 0, dc.height - 1);
    return dpx[(y * dc.width + x) * 4] / 255;
  };
  const world = (uv) => V3((uv.x - 0.5) * PW, (uv.y - 0.5) * PH, depthAt(uv) * DS);

  const tex = (img, srgb = true) => {
    const t = new THREE.Texture(img);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  };

  // ---------- renderer: linear half-float scene, one paint pass to screen ----------

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  pin.prepend(renderer.domElement);
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  const scene = new THREE.Scene();
  const FOV = 35;
  const T = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const view = new THREE.PerspectiveCamera(FOV, 1, 0.004, 200);

  // environment = her own room, so the silver reflects the photo it sits in
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envSrc = tex(photoImg);
  envSrc.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(envSrc).texture;
  scene.environmentIntensity = 1.15;

  const key = new THREE.DirectionalLight(0xffe2c4, 1.6);
  key.position.set(-4, 6, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff9b6a, 1.2);
  rim.position.set(7, 2, -5);
  scene.add(rim);

  const shared = {
    uShard: { value: 1 },         // global on/off (focus mode turns it off)
    uShardFloor: { value: 0.22 }, // a little discretised even from afar
  };

  // ---------- the shared facet chunk ----------

  const SHARD = /* glsl */ `
    uniform float uShard, uShardFloor;
    vec2 shHash(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453);
    }
    // voronoi: seed (same units as p), edge metric, cell random
    vec4 shVoro(vec2 p, float cell) {
      vec2 g = p / cell, i = floor(g), f = fract(g);
      float d1 = 8.0, d2 = 8.0; vec2 best = vec2(0.0), id = vec2(0.0);
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 o = vec2(float(x), float(y));
          vec2 h = shHash(i + o) * 0.9 + 0.05;
          vec2 r = o + h - f;
          float d = dot(r, r);
          if (d < d1) { d2 = d1; d1 = d; best = (i + o + h) * cell; id = i + o; }
          else if (d < d2) { d2 = d; }
        }
      }
      return vec4(best, sqrt(d2) - sqrt(d1), shHash(id + 7.0).x);
    }
    // magnification: screen pixels per 0.01 world units
    float shPPT(vec3 viewPos) {
      float wpp = max(length(dFdx(viewPos)), length(dFdy(viewPos)));
      return 0.01 / max(wpp, 1e-7);
    }
    float shAmount(float ppt) { return max(uShardFloor, smoothstep(1.3, 4.5, ppt)) * uShard; }
    // cells are 0.09 units (9 photo px) and split in two each time magnification doubles
    float shCell(float ppt) { return 0.09 / exp2(floor(clamp(log2(ppt / 8.0), 0.0, 5.0))); }
  `;

  // ---------- painted cards: the photo (displaced) and her hand ----------

  function card({ img, w, h, depthTex = null, iris = false, transparent = false }) {
    const uniforms = {
      ...shared,
      uMap: { value: tex(img) },
      uSize: { value: new THREE.Vector2(w, h) },
      uDepth: { value: depthTex },
      uDS: { value: DS },
      uEye: { value: EYE },
      uIris: { value: 0 },
      uDive: { value: 0 },
    };
    const defines = {};
    if (depthTex) defines.DEPTH = "";
    if (iris) defines.IRIS = "";
    const mat = new THREE.ShaderMaterial({
      uniforms,
      defines,
      transparent,
      depthWrite: !transparent,
      vertexShader: /* glsl */ `
        uniform sampler2D uDepth; uniform float uDS;
        varying vec2 vUv; varying vec3 vView;
        void main() {
          vUv = uv;
          vec3 p = position;
          #ifdef DEPTH
            p.z += texture2D(uDepth, uv).r * uDS;
          #endif
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vView = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform vec2 uSize, uEye; uniform float uIris, uDive;
        varying vec2 vUv; varying vec3 vView;
        ${SHARD}

        vec4 facet(vec2 p, float cell) {
          vec4 v = shVoro(p, cell);
          vec4 c = texture2D(uMap, v.xy / uSize + 0.5);
          vec2 tilt = shHash(v.xy * 13.1 + cell) - 0.5;
          float lit = dot(normalize(vec3(tilt * 0.55, 1.0)), normalize(vec3(-0.5, 0.6, 0.65)));
          c.rgb *= 0.86 + 0.24 * lit;
          c.rgb *= mix(0.75, 1.0, smoothstep(0.0, 0.1, v.z));
          return c;
        }

        #ifdef IRIS
        // faceted iris over the tiny real one, octagonal pupil
        vec4 iris(vec2 d) {
          const float RI = 10.5, RP = 3.9;
          float r = length(d), rn = min(r / RI, 1.0);
          float a = atan(d.y, d.x);
          float h = shHash(vec2(floor((a / 6.2831853 + 0.5) * 44.0), floor(rn * 7.0))).x;
          vec3 c = mix(vec3(0.14, 0.07, 0.03), vec3(0.66, 0.40, 0.15), h * (1.0 - rn) * 0.85 + 0.12);
          c += vec3(0.28, 0.17, 0.06) * (1.0 - smoothstep(0.0, 0.07, abs(rn - 0.52)));
          c *= mix(1.0, 0.3, smoothstep(0.78, 1.0, rn));
          vec2 q = abs(d);
          float oct = max(max(q.x, q.y), (q.x + q.y) * 0.70710678);
          float aa = fwidth(oct) + 0.02;
          c = mix(c, vec3(0.006, 0.008, 0.012), 1.0 - smoothstep(RP - aa, RP + aa, oct));
          float cl = max(abs(d.x + 2.5), abs(d.y - 2.2));
          c = mix(c, vec3(0.96, 0.94, 0.9), (1.0 - smoothstep(1.1 - fwidth(cl), 1.1 + fwidth(cl), cl)) * 0.9);
          float lids = 1.0 - smoothstep(0.9, 1.0, length((d - vec2(0.0, -1.0)) / vec2(30.0, 9.5)));
          float edge = fwidth(r) + 0.3;
          // clamp before pow: a negative channel would become NaN and poison the mix even at alpha 0
          return vec4(pow(max(c, 0.0), vec3(2.2)), (1.0 - smoothstep(RI - edge, RI + edge, r)) * max(lids, uDive));
        }
        #endif

        void main() {
          vec2 p = (vUv - 0.5) * uSize; // world units on the card
          vec4 col = texture2D(uMap, vUv);
          float ppt = shPPT(vView);
          float k = shAmount(ppt);
          if (k > 0.001) {
            float lv = clamp(log2(ppt / 8.0), 0.0, 5.0);
            float cA = 0.09 / exp2(floor(lv));
            vec4 s = mix(facet(p, cA), facet(p, cA * 0.5), smoothstep(0.55, 1.0, fract(lv)));
            col = mix(col, s, k);
          }
          #ifdef IRIS
            if (uIris > 0.0) {
              vec4 ir = iris((vUv - uEye) * vec2(1600.0, 860.0));
              if (ir.a > 0.0) col.rgb = mix(col.rgb, ir.rgb, ir.a * uIris);
            }
          #endif
          if (col.a < 0.02) discard;
          gl_FragColor = col;
        }
      `,
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h, depthTex ? 160 : 1, depthTex ? 86 : 1), mat);
  }

  const portrait = card({ img: photoImg, w: PW, h: PH, depthTex: tex(depthImg, false), iris: true });
  scene.add(portrait);
  const P = portrait.material.uniforms;

  // ---------- the digicam: physical silver with facets injected ----------

  function metal(params, { facets = true } = {}) {
    const m = new THREE.MeshPhysicalMaterial(params);
    m.userData.objScale = { value: 1 };
    if (!facets) return m;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, shared, { uObjScale: m.userData.objScale });
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vShP; varying vec3 vShN;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvShP = transformed; vShN = objectNormal;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vShP; varying vec3 vShN; uniform float uObjScale;\n${SHARD}`)
        .replace(
          "#include <normal_fragment_maps>",
          /* glsl */ `#include <normal_fragment_maps>
          {
            float ppt = shPPT(-vViewPosition);
            float k = shAmount(ppt);
            if (k > 0.001) {
              vec3 an = abs(vShN);
              vec2 sp = (an.z > max(an.x, an.y) ? vShP.xy : an.y > an.x ? vShP.xz : vShP.yz) * uObjScale;
              vec4 v = shVoro(sp, shCell(ppt));
              vec2 tilt = shHash(v.xy * 13.1) - 0.5;
              normal = normalize(normal + vec3(tilt * 0.6, 0.0) * k);
              diffuseColor.rgb *= mix(1.0, mix(0.7, 1.0, smoothstep(0.0, 0.1, v.z)), k);
            }
          }`
        );
    };
    return m;
  }

  const M = {
    silver: metal({ color: 0xd4d6dc, metalness: 1, roughness: 0.3, anisotropy: 0.6, clearcoat: 0.35, clearcoatRoughness: 0.2 }),
    satin: metal({ color: 0x9aa0ac, metalness: 1, roughness: 0.42 }),
    chrome: metal({ color: 0xf2f2f4, metalness: 1, roughness: 0.1 }),
    black: metal({ color: 0x0c0d10, metalness: 0, roughness: 0.38, clearcoat: 0.5 }),
    glass: metal({ color: 0x020305, metalness: 0, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02 }),
    coat: metal({ color: 0x0a2a2c, metalness: 0.4, roughness: 0.08, clearcoat: 1, iridescence: 0.8, iridescenceIOR: 1.6 }),
    flash: metal({ color: 0xe9e7e0, metalness: 0, roughness: 0.18, clearcoat: 1, emissive: 0x000000 }),
    lamp: metal({ color: 0x1a0d06, metalness: 0.2, roughness: 0.05, clearcoat: 1 }),
    led: metal({ color: 0x0a3a1a, emissive: new THREE.Color(0x1aff6a), emissiveIntensity: 0.4 }, { facets: false }),
  };

  const CW = 3.4, CH = 2.0, CD = 0.72, FRONT = CD / 2;
  const SCALE = 1.62;
  const objScaled = [];

  const rig = new THREE.Group(); // camera + her hand, moves as one
  const cam = new THREE.Group(); // the camera, scaled
  cam.scale.setScalar(SCALE);
  rig.add(cam);
  scene.add(rig);

  const add = (geo, mat, x = 0, y = 0, z = 0, parent = cam) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    if (mat.userData.objScale) objScaled.push(mat);
    return m;
  };
  const disc = (r, h, segs = 64) => new THREE.CylinderGeometry(r, r, h, segs).rotateX(Math.PI / 2);
  const ring = (r0, r1, segs = 64) => new THREE.RingGeometry(r0, r1, segs);

  // body: a slab with soft edges and a parting seam
  add(new RoundedBoxGeometry(CW, CH, CD, 10, 0.32), M.silver);
  add(new RoundedBoxGeometry(CW + 0.004, CH + 0.004, 0.02, 4, 0.01), M.black, 0, 0, -0.12);

  // lens, on the side away from her fingers: plate with printed ring, telescoping barrels, octagon glass
  const LX = -0.78, LY = -0.04;
  const lens = new THREE.Group();
  lens.position.set(LX, LY, FRONT);
  cam.add(lens);
  add(disc(0.92, 0.05), M.satin, 0, 0, 0.025, lens);
  add(ring(0.66, 0.9), printedRing(), 0, 0, 0.052, lens);
  add(disc(0.66, 0.2), M.silver, 0, 0, 0.1, lens);
  add(disc(0.57, 0.34), M.satin, 0, 0, 0.17, lens);
  add(disc(0.49, 0.48), M.silver, 0, 0, 0.24, lens);
  add(new THREE.TorusGeometry(0.44, 0.045, 16, 64), M.chrome, 0, 0, 0.48, lens);
  add(disc(0.42, 0.02), M.black, 0, 0, 0.48, lens);
  add(disc(0.3, 0.02), M.coat, 0, 0, 0.485, lens);
  add(disc(0.21, 0.02, 8).rotateZ(Math.PI / 8), M.glass, 0, 0, 0.49, lens);

  // flash window, the small top lamp (our second way in), mic holes, name, specs
  add(new RoundedBoxGeometry(0.8, 0.24, 0.05, 3, 0.06), M.flash, 0.55, 0.66, FRONT);
  add(new RoundedBoxGeometry(0.84, 0.28, 0.03, 3, 0.07), M.chrome, 0.55, 0.66, FRONT - 0.005);
  const LAMP_LOCAL = V3(-0.02, 0.68, FRONT + 0.035);
  add(new THREE.TorusGeometry(0.075, 0.018, 12, 32), M.chrome, LAMP_LOCAL.x, LAMP_LOCAL.y, FRONT + 0.02);
  add(new THREE.SphereGeometry(0.07, 24, 16), M.lamp, LAMP_LOCAL.x, LAMP_LOCAL.y, FRONT + 0.005);
  [-0.06, 0.06].forEach((dx) => add(new THREE.SphereGeometry(0.018, 8, 6), M.black, LX + 0.62 + dx, -0.82, FRONT - 0.005));
  add(new THREE.PlaneGeometry(1.0, 0.28), printed("kimaya", 96, "#40445a", "italic"), 0.95, 0.05, FRONT + 0.002);
  add(new THREE.PlaneGeometry(0.8, 0.12), printed("2.0 MEGA PIXELS", 40, "#5a5e70"), 1.0, -0.72, FRONT + 0.002);

  // top: shutter with zoom collar, power button + led
  add(new THREE.TorusGeometry(0.2, 0.05, 12, 40).rotateX(Math.PI / 2), M.satin, 1.05, CH / 2 + 0.03, 0);
  add(new THREE.CylinderGeometry(0.15, 0.16, 0.12, 40), M.chrome, 1.05, CH / 2 + 0.05, 0);
  add(new RoundedBoxGeometry(0.34, 0.06, 0.16, 2, 0.03), M.satin, 0.3, CH / 2 + 0.02, 0.05);
  add(new THREE.SphereGeometry(0.025, 8, 6), M.led, 0.55, CH / 2 + 0.005, 0.05);

  // back: LCD (the gallery), control pad, buttons
  const lcd = makeLCD();
  const LCD_LOCAL = V3(0.52, 0.02, -FRONT - 0.016);
  add(new RoundedBoxGeometry(2.14, 1.62, 0.02, 3, 0.04), M.black, LCD_LOCAL.x, LCD_LOCAL.y, -FRONT - 0.002);
  const lcdMesh = add(new THREE.PlaneGeometry(1.96, 1.47), lcd.material, LCD_LOCAL.x, LCD_LOCAL.y, LCD_LOCAL.z);
  lcdMesh.rotation.y = Math.PI;
  add(new THREE.TorusGeometry(0.26, 0.06, 12, 40), M.satin, -1.15, -0.28, -FRONT - 0.02);
  add(disc(0.14, 0.04), M.chrome, -1.15, -0.28, -FRONT - 0.02);
  [[-1.1, 0.55], [-1.32, 0.55], [-1.2, -0.8]].forEach(([x, y]) =>
    add(new RoundedBoxGeometry(0.2, 0.14, 0.05, 2, 0.04), M.satin, x, y, -FRONT - 0.01)
  );
  add(new RoundedBoxGeometry(0.42, 0.12, 0.05, 2, 0.05), M.black, -1.15, 0.82, -FRONT - 0.01);
  // strap lug
  add(new THREE.TorusGeometry(0.07, 0.025, 8, 16).rotateY(Math.PI / 2), M.chrome, -CW / 2 - 0.02, 0.55, 0);

  objScaled.forEach((m) => (m.userData.objScale.value = SCALE));

  function printed(text, size, color, style = "") {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 144;
    const g = c.getContext("2d");
    g.fillStyle = color;
    g.font = style ? `${style} ${size}px "Instrument Serif", Georgia, serif` : `${size}px "VT323", monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 256, 76);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshPhysicalMaterial({ map: t, transparent: true, metalness: 0, roughness: 0.6, depthWrite: false });
  }

  function printedRing() {
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const g = c.getContext("2d");
    g.fillStyle = "#9ca1ad";
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = "#3d4152";
    g.font = '30px "VT323", monospace';
    g.textAlign = "center";
    g.textBaseline = "middle";
    const label = "KIMAYA LENS  ·  5x OPTICAL ZOOM  ·  6.2-31mm 1:3.2-5.9  ·  ";
    [...label].forEach((ch, i) => {
      const a = (i / label.length) * Math.PI * 2 - Math.PI / 2;
      g.save();
      g.translate(256 + Math.cos(a) * 200, 256 + Math.sin(a) * 200);
      g.rotate(a + Math.PI / 2);
      g.fillText(ch, 0, 0);
      g.restore();
    });
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return metal({ map: t, metalness: 0.9, roughness: 0.35 });
  }

  // her hand, cut from the original photo, rides with the camera
  const handCard = card({ img: handImg, w: 3.7, h: 4.05, transparent: true });
  rig.add(handCard);

  // the camera sits where her phone was, in her grip
  const GRIP = V3(3.95, -1.9, 0.62);
  // card sits a touch left of where the fingers were, so the palm wraps the body's edge
  handCard.position.set(5.35 - 0.25 - GRIP.x, -2.275 - GRIP.y, FRONT * SCALE + 0.06);
  handCard.renderOrder = 2;
  const HELD = { pos: GRIP, rot: new THREE.Euler(0.04, -0.06, 0.02) };
  const ASIDE = { pos: V3(10.5, -8.2, 2.4), rot: new THREE.Euler(0.8, -1.1, -0.6) };
  const STUDIO = { pos: V3(0, 0, 80), rot: new THREE.Euler(0, 0, 0) };

  // ---------- LCD: canvas texture showing the gallery ----------

  function makeLCD() {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 480;
    const g = c.getContext("2d");
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshPhysicalMaterial({
      color: 0x000000,
      emissive: 0xffffff,
      emissiveMap: t,
      emissiveIntensity: 1.1,
      roughness: 0.12,
      clearcoat: 1,
    });
    return { canvas: c, g, texture: t, material };
  }

  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = LOCAL ? "http://localhost:8787/api" : "https://kimaya-guestbook.kimaya-ink.workers.dev/api";
  const pad = (n) => String(n).padStart(2, "0");
  const stampOf = (d) => `'${pad(d.getFullYear() % 100)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}`;

  const gallery = { items: [], index: 0, imgs: new Map(), lastFlip: 0 };

  async function loadGallery() {
    const items = [];
    try {
      const list = await fetch("photos.json", { cache: "no-cache" }).then((r) => r.json());
      list.forEach((p) => items.push({ src: p.file, date: p.date, caption: p.caption || "", by: p.by || "" }));
    } catch {}
    try {
      const { posts } = await fetch(`${API}/posts`).then((r) => r.json());
      posts.forEach((p) =>
        items.push({
          // own cache key: an earlier non-cors <img> of the same url would taint the canvas
          src: `${API}/photo/${encodeURIComponent(p.id)}?lcd`,
          date: new Date(p.created_at).toISOString().slice(0, 10),
          caption: p.message,
          by: p.name,
        })
      );
    } catch {}
    items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    gallery.items = items;
    drawLCD();
  }

  function imageFor(item) {
    let img = gallery.imgs.get(item.src);
    if (!img) {
      img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { drawLCD(); dirty = true; };
      img.src = item.src;
      gallery.imgs.set(item.src, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  function drawLCD() {
    const { g, canvas } = lcd;
    const W = canvas.width, H = canvas.height;
    g.fillStyle = "#050607";
    g.fillRect(0, 0, W, H);
    const items = gallery.items;
    const item = items[gallery.index % Math.max(items.length, 1)];

    if (item) {
      const img = imageFor(item);
      if (img) {
        const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
        g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      }
      // playback hud
      g.fillStyle = "rgba(0,0,0,.35)";
      g.fillRect(0, 0, W, 44);
      g.fillRect(0, H - 54, W, 54);
      g.font = '30px "VT323", monospace';
      g.textBaseline = "middle";
      g.fillStyle = "#9fe8c8";
      g.textAlign = "left";
      g.fillText("▶", 16, 23);
      g.textAlign = "right";
      g.fillText(`100-${String(gallery.index + 1).padStart(4, "0")}   ${gallery.index + 1}/${items.length}`, W - 16, 23);
      g.textAlign = "left";
      g.fillStyle = "#e9e6df";
      g.font = 'italic 28px "Instrument Serif", Georgia, serif';
      const cap = item.caption + (item.by ? `  — ${item.by}` : "");
      g.fillText(cap.length > 46 ? cap.slice(0, 45) + "…" : cap, 16, H - 27);
      if (item.date) {
        g.font = '34px "VT323", monospace';
        g.textAlign = "right";
        g.shadowColor = "rgba(255,90,0,.9)";
        g.shadowBlur = 8;
        g.fillStyle = "#ff8a1f";
        g.fillText(stampOf(new Date(item.date + "T12:00:00")), W - 16, H - 74);
        g.shadowBlur = 0;
      }
    } else {
      g.font = '40px "VT323", monospace';
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#9fe8c8";
      g.fillText("NO IMAGE", W / 2, H / 2 - 14);
      g.font = '24px "VT323", monospace';
      g.fillStyle = "#8a8780";
      g.fillText("card is waiting for its first picture", W / 2, H / 2 + 22);
    }
    lcd.texture.needsUpdate = true;
  }

  function flip(dir) {
    if (!gallery.items.length) return;
    gallery.index = (gallery.index + dir + gallery.items.length) % gallery.items.length;
    gallery.lastFlip = performance.now();
    drawLCD();
    dirty = true;
  }

  // ---------- backdrop for the camera scenes: painted from her room's colours ----------

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { uAspect: { value: 1 } },
      depthWrite: false,
      depthTest: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uAspect; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        void main() {
          vec2 p = vUv;
          vec3 top = vec3(0.93, 0.86, 0.72), low = vec3(0.42, 0.58, 0.57), pink = vec3(0.95, 0.62, 0.7);
          float wash = n(p * vec2(3.0 * uAspect, 3.0)) + 0.5 * n(p * vec2(9.0 * uAspect, 30.0));
          vec3 col = mix(low, top, smoothstep(0.0, 1.0, p.y + (wash - 0.75) * 0.35));
          col = mix(col, pink, smoothstep(0.7, 0.0, length((p - vec2(0.3, 0.75)) * vec2(uAspect, 1.4))) * 0.35);
          col = floor(col * 10.0 + 0.5) / 10.0 * 0.4 + col * 0.6;
          gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
        }
      `,
    })
  );
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1;
  scene.add(backdrop);

  // ---------- paint pass (linear in, srgb out) ----------

  const post = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rt.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uSeed: { value: 0 },
      uPaint: { value: 0 },
      uBlack: { value: 0 },
      uFlash: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene; uniform vec2 uRes; uniform float uSeed, uPaint, uBlack, uFlash;
      varying vec2 vUv;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      vec3 S(vec2 uv) { return min(texture2D(tScene, uv).rgb, vec3(4.0)); }
      const int R = 3;
      vec3 kuwahara(vec2 uv) {
        vec2 px = 1.0 / uRes;
        vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
        vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
        for (int j = -R; j <= R; j++) {
          for (int i = -R; i <= R; i++) {
            vec3 c = S(uv + vec2(float(i), float(j)) * px);
            vec3 c2 = c * c;
            if (i <= 0 && j <= 0) { m0 += c; s0 += c2; }
            if (i >= 0 && j <= 0) { m1 += c; s1 += c2; }
            if (i <= 0 && j >= 0) { m2 += c; s2 += c2; }
            if (i >= 0 && j >= 0) { m3 += c; s3 += c2; }
          }
        }
        float n = float((R + 1) * (R + 1));
        m0 /= n; m1 /= n; m2 /= n; m3 /= n;
        float v0 = dot(s0 / n - m0 * m0, vec3(1.0));
        float v1 = dot(s1 / n - m1 * m1, vec3(1.0));
        float v2 = dot(s2 / n - m2 * m2, vec3(1.0));
        float v3 = dot(s3 / n - m3 * m3, vec3(1.0));
        vec3 c = m0; float v = v0;
        if (v1 < v) { c = m1; v = v1; }
        if (v2 < v) { c = m2; v = v2; }
        if (v3 < v) { c = m3; }
        return c;
      }
      void main() {
        vec2 px = 1.0 / uRes;
        vec2 wob = vec2(noise(vec3(vUv * uRes * 0.06, uSeed)), noise(vec3(vUv * uRes * 0.06 + 9.1, uSeed))) - 0.5;
        vec2 uv = vUv + wob * px * 3.0 * uPaint;
        vec3 raw = S(vUv);
        vec3 col = uPaint > 0.01 ? mix(raw, kuwahara(uv), uPaint) : raw;
        vec2 off = (vUv - 0.5) * px * 6.0 * (0.3 + uPaint);
        col.r = mix(col.r, S(uv + off).r, 0.35);
        col.b = mix(col.b, S(uv - off).b, 0.35);
        // soft shoulder for the metal highlights, then display encode
        col = col / (1.0 + max(col - 0.85, 0.0));
        col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
        float vig = smoothstep(1.1, 0.35, length((vUv - 0.5) * vec2(1.1, 1.0)));
        col *= mix(0.62, 1.0, vig);
        col += (hash(vec3(vUv * uRes, uSeed * 13.0)) - 0.5) * 0.05;
        col *= 1.0 - uBlack;
        col = mix(col, vec3(1.0, 0.98, 0.94), uFlash);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const postScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post);
  quad.frustumCulled = false;
  postScene.add(quad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---------- poses ----------

  const STUDIO_AT = 0.74;

  function poseRig(p) {
    if (p >= STUDIO_AT) {
      rig.position.copy(STUDIO.pos);
      rig.rotation.copy(STUDIO.rot);
      handCard.visible = false;
      rig.visible = true;
      return;
    }
    const a = smootherstep(p, 0.05, 0.28);
    rig.position.lerpVectors(HELD.pos, ASIDE.pos, a);
    rig.rotation.set(lerp(HELD.rot.x, ASIDE.rot.x, a), lerp(HELD.rot.y, ASIDE.rot.y, a), lerp(HELD.rot.z, ASIDE.rot.z, a));
    handCard.visible = true;
    rig.visible = a < 0.999;
  }

  // world positions of camera parts in the studio pose
  function studioPoint(local) {
    rig.position.copy(STUDIO.pos);
    rig.rotation.copy(STUDIO.rot);
    rig.updateMatrixWorld(true);
    return cam.localToWorld(local.clone());
  }
  const LAMP = studioPoint(LAMP_LOCAL);
  const LCD_W = studioPoint(LCD_LOCAL);
  const CAM_W = studioPoint(V3(0, 0, 0));

  let keys = [];
  let aspect = 1;
  const fit = (w, h) => Math.max(h / 2 / T, w / 2 / (T * aspect));
  const CUTS = [0.74, 0.885];

  function buildPath() {
    const cover = Math.min(PH / 2 / T, PW / 2 / (T * aspect)) * 0.97;
    const visW = 2 * cover * T * aspect;
    const startX = clamp(1.2, -PW / 2 + visW / 2, PW / 2 - visW / 2);
    const face = world(FACE), between = world(BETWEEN), eye = world(EYE);
    const k = (p, look, dir, dist) => ({ p, look: look.clone(), dir: dir.clone().normalize(), dist });
    const Z = V3(0, 0, 1);
    keys = [
      k(0.0, V3(startX, 0, 0), Z, cover),
      k(0.16, V3(lerp(startX, face.x, 0.6), face.y * 0.5, face.z * 0.5), V3(0.04, 0, 1), cover * 0.8),
      k(0.3, face.clone().add(V3(-0.5, 0, 0)), V3(0.1, 0.02, 1), fit(4.6, 4.8)),
      k(0.44, between, V3(0.05, 0.03, 1), fit(2.9, 1.3)),
      k(0.56, eye, V3(0.02, 0.01, 1), fit(0.95, 0.5)),
      k(0.66, eye, Z, 0.17),
      k(0.74, eye, Z, 0.012),
      // cut: the camera's front, as she sees it
      k(0.745, CAM_W, Z, fit(6.4, 4.4)),
      k(0.8, LAMP.clone().lerp(CAM_W, 0.4), Z, fit(3.2, 2.0)),
      k(0.885, LAMP, Z, 0.022),
      // cut: out the other side
      k(0.89, LCD_W, V3(0, 0, -1), 0.4),
      k(0.97, CAM_W, V3(-0.24, 0.1, -1), fit(6.8, 4.6)),
      k(1.0, CAM_W, V3(-0.18, 0.08, -1), fit(6.6, 4.5)),
    ];
  }

  const tmpLook = V3(), tmpDir = V3();
  function pathPose(p, outPos, outLook) {
    let i = 0;
    while (i < keys.length - 2 && p > keys[i + 1].p) i++;
    const a = keys[i], b = keys[i + 1];
    const t = smootherstep(p, a.p, b.p);
    const u = CUTS.includes(a.p) ? (p < b.p ? 0 : 1) : t;
    tmpLook.lerpVectors(a.look, b.look, u);
    tmpDir.lerpVectors(a.dir, b.dir, u).normalize();
    const dist = Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), u));
    outPos.copy(tmpLook).addScaledVector(tmpDir, dist);
    outLook.copy(tmpLook);
  }

  // ---------- focus mode: the LCD fills the page ----------

  const focus = { on: false, t: 0, savedY: 0 };

  function lcdPose(outPos, outLook) {
    outLook.copy(LCD_W);
    outPos.copy(LCD_W).add(V3(0, 0, -fit(1.96 * SCALE * 1.04, 1.47 * SCALE * 1.04)));
  }

  function enterFocus() {
    if (focus.on) return;
    focus.on = true;
    focus.savedY = scrollY;
    document.body.style.top = `-${focus.savedY}px`;
    document.body.classList.add("j-locked");
    journey.classList.add("focused");
    dirty = true;
  }

  function exitFocus() {
    if (!focus.on) return;
    focus.on = false;
    document.body.classList.remove("j-locked");
    document.body.style.top = "";
    scrollTo(0, focus.savedY);
    journey.classList.remove("focused");
    dirty = true;
  }

  journey.querySelector(".j-focus-btn")?.addEventListener("click", (e) => { e.stopPropagation(); enterFocus(); });
  journey.querySelector(".j-exit")?.addEventListener("click", exitFocus);
  journey.querySelector(".j-prev")?.addEventListener("click", () => flip(-1));
  journey.querySelector(".j-next")?.addEventListener("click", () => flip(1));
  addEventListener("keydown", (e) => {
    if (!focus.on) return;
    if (e.key === "Escape") exitFocus();
    if (e.key === "ArrowLeft") flip(-1);
    if (e.key === "ArrowRight") flip(1);
  });

  // ---------- frame ----------

  const hud = {
    zoom: journey.querySelector(".j-zoom i"),
    hint: journey.querySelector(".j-hint"),
    brackets: journey.querySelector(".j-focus"),
  };

  let target = 0, prog = 0, frameNo = 0, flashT = 0, dirty = true;
  const curPos = V3(), curLook = V3(), lcdPos = V3(), lcdLook = V3(), mixLook = V3();

  const pinned = new URLSearchParams(location.search).get("p"); // dev: ?p=0.5 freezes the journey

  function readScroll() {
    if (focus.on) return;
    if (pinned !== null) { target = clamp(parseFloat(pinned) || 0, 0, 1); return; }
    const r = journey.getBoundingClientRect();
    const span = r.height - innerHeight;
    target = span > 0 ? clamp(-r.top / span, 0, 1) : 0;
  }

  function draw() {
    const p = prog;
    journey.progress = p;
    poseRig(p);
    pathPose(p, curPos, curLook);

    const fe = smootherstep(focus.t, 0, 1);
    if (fe > 0) {
      lcdPose(lcdPos, lcdLook);
      view.position.lerpVectors(curPos, lcdPos, fe);
      view.lookAt(mixLook.lerpVectors(curLook, lcdLook, fe));
    } else {
      view.position.copy(curPos);
      view.lookAt(curLook);
    }

    const studio = p >= STUDIO_AT;
    portrait.visible = !studio;
    backdrop.visible = studio;

    const close = studio
      ? 0.55 + 0.35 * smootherstep(p, 0.78, 0.88) - 0.3 * smootherstep(p, 0.89, 0.97)
      : smootherstep(p, 0.08, 0.5);
    post.uniforms.uPaint.value = (0.12 + 0.88 * close) * (1 - fe);
    shared.uShard.value = 1 - fe;
    P.uIris.value = studio ? 0 : smootherstep(p, 0.46, 0.56);
    P.uDive.value = smootherstep(p, 0.6, 0.68);

    const b1 = smootherstep(p, 0.7, 0.738) * (1 - smootherstep(p, 0.745, 0.77));
    const b2 = smootherstep(p, 0.86, 0.884) * (1 - smootherstep(p, 0.89, 0.915));
    post.uniforms.uBlack.value = Math.max(b1, b2) * (1 - fe);

    post.uniforms.uSeed.value = calm ? 0 : frameNo % 3;
    M.flash.emissive.setScalar(flashT * 3);
    post.uniforms.uFlash.value = flashT * 0.85;
    flashT = Math.max(0, flashT - 0.25);

    renderer.setRenderTarget(rt);
    renderer.render(scene, view);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);

    if (hud.zoom) hud.zoom.style.width = `${Math.round(Math.min(p / STUDIO_AT, 1) * 100)}%`;
    if (hud.hint) hud.hint.hidden = p > 0.02;
    if (hud.brackets) hud.brackets.classList.toggle("locked", (p > 0.3 && p < 0.7) || (p > 0.76 && p < 0.86));
    journey.classList.toggle("at-end", p > 0.95);
  }

  const maxScale = Math.min(devicePixelRatio || 1, 1);
  let scale = maxScale;

  function resize() {
    const w = pin.clientWidth, h = pin.clientHeight;
    if (!w || !h) return;
    const bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale));
    renderer.setPixelRatio(1);
    renderer.setSize(bw, bh, false);
    rt.setSize(bw, bh);
    post.uniforms.uRes.value.set(bw, bh);
    backdrop.material.uniforms.uAspect.value = w / h;
    aspect = w / h;
    view.aspect = aspect;
    view.updateProjectionMatrix();
    buildPath();
    dirty = true;
    draw();
  }

  // ---------- input ----------

  pin.addEventListener("click", (e) => {
    if (focus.on || e.target.closest("button, a")) return;
    if (prog > 0.1) return;
    // at the very start, pressing her camera fires its flash
    flashT = 1;
    dirty = true;
  });

  addEventListener("scroll", () => { readScroll(); dirty = true; }, { passive: true });
  new ResizeObserver(resize).observe(pin);
  readScroll();
  prog = target;
  loadGallery();
  resize();

  let lastBoil = 0, lastT = performance.now(), slow = 0, onScreen = true;
  const born = lastT;
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(journey);

  (function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - lastT) / 1000, 0.5);
    lastT = now;
    if ((!onScreen && !focus.on) || document.hidden) return;

    // sustained slow frames: render smaller; sustained fast: claw it back.
    // skip the first seconds, shader compiles stall everyone.
    if (now - born > 2500) {
      slow = dt > 0.045 ? slow + 1 : dt < 0.022 ? slow - 1 : slow;
      if (slow > 4 && scale > 0.35) { scale = Math.max(0.35, scale * 0.7); slow = 0; resize(); }
      else if (slow < -90 && scale < maxScale) { scale = Math.min(maxScale, scale * 1.25); slow = 0; resize(); }
    }

    const moving = Math.abs(target - prog) > 1e-4;
    if (moving) prog += (target - prog) * (calm ? 1 : 1 - Math.exp(-dt * 7));

    const ft = focus.on ? 1 : 0;
    const focusMoving = Math.abs(focus.t - ft) > 1e-3;
    focus.t = focusMoving ? focus.t + (ft - focus.t) * (1 - Math.exp(-dt * 5)) : ft;

    // the LCD slideshows by itself while you're looking at the back
    if (!focus.on && prog > 0.9 && now - gallery.lastFlip > 3500) flip(1);

    const boil = !calm && now - lastBoil > 1000 / 12;
    if (boil) { lastBoil = now; frameNo++; }
    if (moving || focusMoving || boil || dirty || flashT > 0) {
      dirty = false;
      draw();
    }
  })(performance.now());
}
