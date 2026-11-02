// scroll journey:
//   kimaya (sculpted, not photographed) holding a digicam up at us -> she lowers it -> her face ->
//   her eyes -> into the pupil -> (cut) the camera's front, as she sees it -> into its small
//   top lamp -> (cut) out the other side: the camera's back, whose LCD is the gallery and the
//   booth. FOCUS hands you the camera; its own buttons drive it.
//
// one art process for everything: smooth and physically lit from afar, and the closer you get
// the more every surface (skin, hair, metal, room) breaks into facets. facets are anchored to
// the surface and sized by real magnification (screen px per 0.01 world units). one paint pass.
// the figure is meshed offline by tools/sculpt.mjs.

const journey = document.getElementById("journey");
const pin = journey.querySelector(".journey-pin");

try {
  const THREE = await import("three");
  const { RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js");
  const [photo, sticker, fig, figBuf] = await Promise.all([
    loadImage("assets/kimaya.jpg"),
    loadImage("assets/sticker.png"),
    fetch("assets/figure.json").then((r) => r.json()),
    fetch("assets/figure.bin").then((r) => r.arrayBuffer()),
  ]);
  await document.fonts.load('30px "VT323"').catch(() => {});
  init(THREE, RoundedBoxGeometry, photo, sticker, fig, figBuf);
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

function init(THREE, RoundedBoxGeometry, photoImg, stickerImg, fig, figBuf) {
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { smootherstep, lerp, clamp } = THREE.MathUtils;
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const VA = (a) => new THREE.Vector3(a[0], a[1], a[2]);

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
  const view = new THREE.PerspectiveCamera(FOV, 1, 0.004, 300);

  // environment = her own room, so skin and silver pick up its pastel light
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envSrc = tex(photoImg);
  envSrc.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(envSrc).texture;
  scene.environmentIntensity = 0.9;

  const key = new THREE.DirectionalLight(0xffe0c2, 2.2);
  key.position.set(-5, 6, 9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff9466, 2.4); // the warm mielgo edge
  rim.position.set(8, 3, -6);
  scene.add(rim);
  const fill = new THREE.HemisphereLight(0xbfe6ff, 0x7a5a50, 0.5);
  scene.add(fill);

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
    vec3 shHash3(vec3 p) {
      p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
      return fract(sin(p) * 43758.5453);
    }
    // 2d voronoi: seed (same units as p), edge metric, cell random
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
    // 3d voronoi for curved, organic surfaces: cell random (xyz), edge metric
    vec4 shVoro3(vec3 p, float cell) {
      vec3 g = p / cell, i = floor(g), f = fract(g);
      float d1 = 8.0, d2 = 8.0; vec3 id = vec3(0.0);
      for (int z = -1; z <= 1; z++) {
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec3 o = vec3(float(x), float(y), float(z));
            vec3 r = o + shHash3(i + o) * 0.9 + 0.05 - f;
            float d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; id = i + o; }
            else if (d < d2) { d2 = d; }
          }
        }
      }
      return vec4(shHash3(id + 7.0), sqrt(d2) - sqrt(d1));
    }
    // magnification: screen pixels per 0.01 world units
    float shPPT(vec3 viewPos) {
      float wpp = max(length(dFdx(viewPos)), length(dFdy(viewPos)));
      return 0.01 / max(wpp, 1e-7);
    }
    float shAmount(float ppt, float floorMul) { return max(uShardFloor * floorMul, smoothstep(1.3, 4.5, ppt)) * uShard; }
    // cells are 0.09 units and split in two each time magnification doubles
    float shCell(float ppt) { return 0.09 / exp2(floor(clamp(log2(ppt / 8.0), 0.0, 5.0))); }
  `;

  // physical material + facets. facets: "2d" for flat-faced hard surfaces, "3d" for skin/hair.
  // positions are taken in object space times the object's scale, so facets stick to the surface
  // and keep one world size whether the camera is held small or shown big.
  function metal(params, { facets = "2d", floor = 1, iris = false } = {}) {
    const m = new THREE.MeshPhysicalMaterial(params);
    if (!facets) return m;
    m.defines = { ...(m.defines || {}), [facets === "3d" ? "FACET3D" : "FACET2D"]: "", ...(iris ? { IRIS: "" } : {}) };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, shared, { uFloorMul: { value: floor } });
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vShP; varying vec3 vShN; varying vec3 vShO;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvShO = transformed; vShP = transformed * length(modelMatrix[0].xyz); vShN = objectNormal;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying vec3 vShP; varying vec3 vShN; varying vec3 vShO; uniform float uFloorMul;\n${SHARD}`)
        .replace(
          "#include <color_fragment>",
          /* glsl */ `#include <color_fragment>
          #ifdef IRIS
          {
            // faceted brown iris and an octagonal pupil on the eyeball's front (+z)
            vec3 q = normalize(vShO);
            if (q.z > 0.0) {
              const float RI = 0.42, RP = 0.15;
              vec2 d = q.xy;
              float r = length(d), rn = min(r / RI, 1.0);
              float a = atan(d.y, d.x);
              float h = shHash(vec2(floor((a / 6.2831853 + 0.5) * 44.0), floor(rn * 7.0))).x;
              vec3 c = mix(vec3(0.14, 0.07, 0.03), vec3(0.66, 0.40, 0.15), h * (1.0 - rn) * 0.85 + 0.12);
              c += vec3(0.28, 0.17, 0.06) * (1.0 - smoothstep(0.0, 0.07, abs(rn - 0.52)));
              c *= mix(1.0, 0.3, smoothstep(0.78, 1.0, rn));
              vec2 ab = abs(d);
              float oct = max(max(ab.x, ab.y), (ab.x + ab.y) * 0.70710678);
              float aa = fwidth(oct) + 1e-4;
              c = mix(c, vec3(0.006, 0.008, 0.012), 1.0 - smoothstep(RP - aa, RP + aa, oct));
              float e = fwidth(r) + 0.004;
              diffuseColor.rgb = mix(diffuseColor.rgb, pow(max(c, 0.0), vec3(2.2)), 1.0 - smoothstep(RI - e, RI + e, r));
            }
          }
          #endif`
        )
        .replace(
          "#include <normal_fragment_maps>",
          /* glsl */ `#include <normal_fragment_maps>
          {
            float ppt = shPPT(-vViewPosition);
            float k = shAmount(ppt, uFloorMul);
            if (k > 0.001) {
              #ifdef FACET3D
                vec4 v = shVoro3(vShP, shCell(ppt));
                normal = normalize(normal + (v.xyz - 0.5) * 0.7 * k);
                diffuseColor.rgb *= mix(1.0, mix(0.78, 1.0, smoothstep(0.0, 0.1, v.w)) * (0.92 + 0.16 * v.x), k);
              #else
                vec3 an = abs(vShN);
                vec2 sp = an.z > max(an.x, an.y) ? vShP.xy : an.y > an.x ? vShP.xz : vShP.yz;
                vec4 v = shVoro(sp, shCell(ppt));
                vec2 tilt = shHash(v.xy * 13.1) - 0.5;
                normal = normalize(normal + vec3(tilt * 0.6, 0.0) * k);
                diffuseColor.rgb *= mix(1.0, mix(0.7, 1.0, smoothstep(0.0, 0.1, v.z)), k);
              #endif
            }
          }`
        );
    };
    m.customProgramCacheKey = () => `kimaya-${facets}-${iris}`;
    return m;
  }

  const M = {
    silver: metal({ color: 0xd4d6dc, metalness: 1, roughness: 0.3, anisotropy: 0.6, clearcoat: 0.35, clearcoatRoughness: 0.2 }),
    satin: metal({ color: 0x9aa0ac, metalness: 1, roughness: 0.42 }),
    bright: metal({ color: 0xe4e6ea, metalness: 1, roughness: 0.22 }),
    chrome: metal({ color: 0xf2f2f4, metalness: 1, roughness: 0.1 }),
    black: metal({ color: 0x0c0d10, metalness: 0, roughness: 0.38, clearcoat: 0.5 }),
    glass: metal({ color: 0x020305, metalness: 0, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02 }),
    coat: metal({ color: 0x0a2a2c, metalness: 0.4, roughness: 0.08, clearcoat: 1, iridescence: 0.8, iridescenceIOR: 1.6 }),
    flash: metal({ color: 0xe9e7e0, metalness: 0, roughness: 0.18, clearcoat: 1, emissive: 0x000000 }),
    lamp: metal({ color: 0x1a0d06, metalness: 0.2, roughness: 0.05, clearcoat: 1 }),
    led: metal({ color: 0x0a3a1a, emissive: new THREE.Color(0x1aff6a), emissiveIntensity: 0.4 }, { facets: false }),
    skin: metal({ vertexColors: true, roughness: 0.52, sheen: 0.5, sheenColor: new THREE.Color(0xff9a80), sheenRoughness: 0.55, clearcoat: 0.12, clearcoatRoughness: 0.5 }, { facets: "3d", floor: 0.55 }),
    hair: metal({ vertexColors: true, roughness: 0.55, sheen: 0.7, sheenColor: new THREE.Color(0x9a6a6e), sheenRoughness: 0.4, clearcoat: 0.08, clearcoatRoughness: 0.4 }, { facets: "3d", floor: 0.8 }),
    eye: metal({ color: 0xe9e3dc, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 }, { facets: "3d", floor: 0.3, iris: true }),
  };

  // ---------- the digicam (built twice: small in her hand, big in the studio) ----------

  const CW = 3.4, CH = 2.0, CD = 0.72, FRONT = CD / 2;
  const lcd = makeLCD();
  const disc = (r, h, segs = 64) => new THREE.CylinderGeometry(r, r, h, segs).rotateX(Math.PI / 2);
  const ring = (r0, r1, segs = 64) => new THREE.RingGeometry(r0, r1, segs);

  function printed(text, size, color, { style = "", w = 512, h = 144 } = {}) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = color;
    g.font = style ? `${style} ${size}px "Instrument Serif", Georgia, serif` : `${size}px "VT323", monospace`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, w / 2, h / 2 + 4);
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

  // the mode dial's printed face: scene icons around the rim, like the real one
  function dialFace() {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    g.fillStyle = "#c9ccd3";
    g.beginPath();
    g.arc(128, 128, 128, 0, 7);
    g.fill();
    g.fillStyle = "#23252e";
    g.font = '30px "VT323", monospace';
    g.textAlign = "center";
    g.textBaseline = "middle";
    ["SCN", "P", "▣", "EASY", "☺", "♪"].forEach((s, i) => {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      g.fillText(s, 128 + Math.cos(a) * 86, 128 + Math.sin(a) * 86);
    });
    g.fillStyle = "#1aa6a0";
    g.beginPath();
    g.arc(128, 128, 18, 0, 7);
    g.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return metal({ map: t, metalness: 0.7, roughness: 0.35 });
  }

  function makeCamera(scale) {
    const cam = new THREE.Group();
    cam.scale.setScalar(scale);
    const buttons = [];
    const add = (geo, mat, x = 0, y = 0, z = 0, parent = cam, action = null) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      if (action) { m.userData.action = action; buttons.push(m); }
      return m;
    };

    // body: a slab with soft edges and a parting seam
    add(new RoundedBoxGeometry(CW, CH, CD, 10, 0.32), M.silver);
    add(new RoundedBoxGeometry(CW + 0.004, CH + 0.004, 0.02, 4, 0.01), M.black, 0, 0, -0.12);

    // front, real cyber-shot layout: lens right of centre, flash top-left, the small lamp between
    const LX = 0.78, LY = -0.04;
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
    const flash = add(new RoundedBoxGeometry(0.8, 0.24, 0.05, 3, 0.06), M.flash, -0.55, 0.64, FRONT);
    add(new RoundedBoxGeometry(0.84, 0.28, 0.03, 3, 0.07), M.chrome, -0.55, 0.64, FRONT - 0.005);
    const lampLocal = V3(-0.02, 0.66, FRONT + 0.035);
    add(new THREE.TorusGeometry(0.075, 0.018, 12, 32), M.chrome, lampLocal.x, lampLocal.y, FRONT + 0.02);
    add(new THREE.SphereGeometry(0.07, 24, 16), M.lamp, lampLocal.x, lampLocal.y, FRONT + 0.005);
    [-0.06, 0.06].forEach((dx) => add(new THREE.SphereGeometry(0.018, 8, 6), M.black, 0.14 + dx, -0.84, FRONT - 0.005));
    add(new THREE.PlaneGeometry(0.9, 0.25), printed("kimaya", 96, "#40445a", { style: "italic" }), -0.5, -0.32, FRONT + 0.002);
    add(new THREE.PlaneGeometry(0.62, 0.1), printed("2.0 MEGA PIXELS", 40, "#5a5e70"), 1.25, -0.86, FRONT + 0.002);
    add(new THREE.PlaneGeometry(0.3, 0.16), printed("5x", 90, "#5a5e70"), 1.42, 0.78, FRONT + 0.002);

    // top: shutter with zoom collar at her right hand's end, power + led
    add(new THREE.TorusGeometry(0.2, 0.05, 12, 40).rotateX(Math.PI / 2), M.satin, -1.05, CH / 2 + 0.03, 0);
    add(new THREE.CylinderGeometry(0.15, 0.16, 0.12, 40), M.chrome, -1.05, CH / 2 + 0.05, 0, cam, "shutter");
    add(new RoundedBoxGeometry(0.34, 0.06, 0.16, 2, 0.03), M.satin, -0.3, CH / 2 + 0.02, 0.05);
    add(new THREE.SphereGeometry(0.025, 8, 6), M.led, -0.55, CH / 2 + 0.005, 0.05);

    // back, after the real one: framed LCD on the left (from behind), the name under it,
    // zoom rocker, mode dial, play button, control wheel, MENU / HOME on the right
    const BZ = -FRONT;
    const back = new THREE.Group();
    back.position.z = BZ;
    back.rotation.y = Math.PI; // local +x of the back group = our right when we look at the back
    cam.add(back);
    // in back-group coords, x grows to the right as seen from behind
    add(new RoundedBoxGeometry(2.3, 1.78, 0.04, 3, 0.1), M.bright, -0.52, 0.02, 0.0, back);
    add(new RoundedBoxGeometry(2.08, 1.56, 0.02, 3, 0.05), M.black, -0.52, 0.06, 0.022, back);
    const lcdMesh = add(new THREE.PlaneGeometry(1.92, 1.44), lcd.material, -0.52, 0.06, 0.034, back);
    add(new THREE.PlaneGeometry(0.62, 0.15), printed("kimaya", 90, "#3a3e52", { style: "italic" }), -0.52, -0.78, 0.023, back);

    add(new RoundedBoxGeometry(0.52, 0.17, 0.06, 2, 0.08), M.chrome, 1.12, 0.74, 0.0, back, "zoom");
    add(new THREE.PlaneGeometry(0.6, 0.1), printed("W        T", 50, "#2d3040"), 1.12, 0.6, 0.01, back);
    // mode dial: knurled edge + printed face
    add(new THREE.CylinderGeometry(0.31, 0.31, 0.06, 64).rotateX(Math.PI / 2), M.chrome, 1.08, 0.24, 0.02, back, "rec");
    add(new THREE.TorusGeometry(0.31, 0.022, 6, 96), M.satin, 1.08, 0.24, 0.05, back);
    add(new THREE.CircleGeometry(0.27, 48), dialFace(), 1.08, 0.24, 0.054, back, "rec");
    // play button
    add(disc(0.085, 0.05), M.chrome, 0.8, -0.12, 0.02, back, "play");
    add(new THREE.PlaneGeometry(0.14, 0.1), printed("▶", 110, "#2d3040", { w: 160, h: 120 }), 0.8, 0.0, 0.01, back);
    // control wheel: left / right flip photos, centre = ok
    add(new THREE.TorusGeometry(0.27, 0.06, 12, 48), M.bright, 1.1, -0.38, 0.03, back, "wheel");
    add(disc(0.25, 0.04), M.satin, 1.1, -0.38, 0.02, back, "wheel");
    add(new THREE.PlaneGeometry(0.2, 0.08), printed("DISP", 80, "#2d3040", { w: 256, h: 100 }), 1.1, -0.2, 0.045, back);
    add(disc(0.09, 0.07), M.chrome, 1.1, -0.38, 0.05, back, "ok");
    // menu / home
    add(disc(0.085, 0.05), M.chrome, 0.78, -0.82, 0.02, back, "menu");
    add(disc(0.085, 0.05), M.chrome, 1.4, -0.82, 0.02, back, "home");
    add(new THREE.PlaneGeometry(0.42, 0.08), printed("MENU      HOME", 44, "#2d3040"), 1.09, -0.94, 0.01, back);
    // her sticker, slapped on the corner of the screen frame
    const stickerMat = new THREE.MeshPhysicalMaterial({ map: tex(stickerImg), transparent: true, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.15, depthWrite: false });
    const st = add(new THREE.PlaneGeometry(0.62, 0.62), stickerMat, -1.42, 0.62, 0.046, back);
    st.rotation.z = 0.22;
    st.renderOrder = 3;

    // strap lug
    add(new THREE.TorusGeometry(0.07, 0.025, 8, 16).rotateY(Math.PI / 2), M.chrome, CW / 2 + 0.02, 0.55, 0);

    return { group: cam, buttons, lampLocal, lcdMesh, flash, back };
  }

  // ---------- kimaya, sculpted ----------

  const P = fig.points;
  const figure = new THREE.Group();
  scene.add(figure);

  function partGeometry(name) {
    const p = fig.parts[name];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(figBuf, p.pos, p.vertices * 3), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Int8Array(figBuf, p.nrm, p.vertices * 3), 3, true));
    // the sculpt writes display colours; three wants linear vertex colours
    const raw = new Uint8Array(figBuf, p.col, p.vertices * 3);
    const lin = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) lin[i] = Math.pow(raw[i] / 255, 2.2);
    g.setAttribute("color", new THREE.BufferAttribute(lin, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(figBuf, p.idx, p.indices), 1));
    g.computeBoundingSphere();
    return g;
  }

  figure.add(new THREE.Mesh(partGeometry("head"), M.skin));
  figure.add(new THREE.Mesh(partGeometry("body"), M.skin));
  figure.add(new THREE.Mesh(partGeometry("hair"), M.hair));
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(P.eyeRadius, 48, 32), M.eye);
  eyeL.position.copy(VA(P.eyeL));
  const eyeR = eyeL.clone();
  eyeR.position.copy(VA(P.eyeR));
  figure.add(eyeL, eyeR);

  // forearm + hand + the small camera swing together about the elbow
  const ELBOW = VA(P.elbow);
  const arm = new THREE.Group();
  arm.position.copy(ELBOW);
  figure.add(arm);
  const armMesh = new THREE.Mesh(partGeometry("arm"), M.skin);
  armMesh.position.copy(ELBOW).negate();
  arm.add(armMesh);
  const held = makeCamera(P.camScale);
  held.group.position.copy(VA(P.camPos)).sub(ELBOW);
  arm.add(held.group);

  // the studio camera: same object, shown big on its own
  const STUDIO_SCALE = 1.62;
  const studioCam = makeCamera(STUDIO_SCALE);
  studioCam.group.position.set(0, 0, 120);
  scene.add(studioCam.group);

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
  const playVideo = Object.assign(document.createElement("video"), { playsInline: true, muted: true, loop: true, crossOrigin: "anonymous" });

  async function loadGallery() {
    const items = [];
    try {
      const list = await fetch("photos.json", { cache: "no-cache" }).then((r) => r.json());
      list.forEach((p) => items.push({ src: p.file, clip: p.clip || null, date: p.date, caption: p.caption || "", by: p.by || "", song: p.song || null }));
    } catch {}
    try {
      const { posts } = await fetch(`${API}/posts`).then((r) => r.json());
      posts.forEach((p) =>
        items.push({
          // own cache key: an earlier non-cors <img> of the same url would taint the canvas
          src: `${API}/photo/${encodeURIComponent(p.id)}?lcd`,
          clip: p.has_clip ? `${API}/clip/${encodeURIComponent(p.id)}?lcd` : null,
          date: p.taken_on || new Date(p.created_at).toISOString().slice(0, 10),
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
    if (rec.mode !== "play") drawRec(g, W, H);
    else drawPlay(g, W, H);
    lcd.texture.needsUpdate = true;
  }

  function drawPlay(g, W, H) {
    const items = gallery.items;
    const item = items[gallery.index % Math.max(items.length, 1)];

    if (item) {
      const img = imageFor(item);
      if (item.clip) {
        if (playVideo.dataset.src !== item.clip) {
          playVideo.dataset.src = item.clip;
          playVideo.src = item.clip;
          playVideo.play().catch(() => {});
        }
      } else if (playVideo.dataset.src) {
        playVideo.pause();
        playVideo.removeAttribute("src");
        delete playVideo.dataset.src;
      }
      if (item.clip && playVideo.readyState >= 2) {
        cover(g, playVideo, playVideo.videoWidth, playVideo.videoHeight, W, H);
      } else if (img) {
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
      if (item.song) {
        g.font = '26px "VT323", monospace';
        g.textAlign = "left";
        g.fillStyle = "#e9e6df";
        const line = `♪ ${item.song.title} — ${item.song.artist}`;
        g.fillText(line.length > 44 ? line.slice(0, 43) + "…" : line, 16, 64);
      }
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
  }

  function flip(dir) {
    if (!gallery.items.length) return;
    gallery.index = (gallery.index + dir + gallery.items.length) % gallery.items.length;
    gallery.lastFlip = performance.now();
    drawLCD();
    songChip();
    dirty = true;
  }

  // in focus mode the current photo's song gets a real play chip
  const songSlot = journey.querySelector(".j-song");
  function songChip() {
    if (!songSlot) return;
    const item = gallery.items[gallery.index];
    const show = focus.on && rec.mode === "play" && item?.song && window.KimayaSongs;
    songSlot.replaceChildren(...(show ? [window.KimayaSongs.chip(item.song)] : []));
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

  // her room, painted from the photo's colours: butter-yellow wall, teal floral paper.
  // it gets the same facets as everything else.
  const room = new THREE.Mesh(
    new THREE.PlaneGeometry(70, 40),
    new THREE.ShaderMaterial({
      uniforms: { ...shared },
      vertexShader: `varying vec3 vView; varying vec2 vP; void main(){ vP = position.xy; vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vView; varying vec2 vP;
        ${SHARD}
        float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          float a = shHash(i).x, b = shHash(i+vec2(1,0)).x, c = shHash(i+vec2(0,1)).x, d = shHash(i+vec2(1,1)).x;
          return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
        vec3 paint(vec2 p) {
          vec3 butter = vec3(0.95, 0.9, 0.58), paper = vec3(0.72, 0.86, 0.84), teal = vec3(0.45, 0.74, 0.78), pink = vec3(0.98, 0.72, 0.76);
          float side = smoothstep(-6.0, 4.0, p.x + (n2(p * 0.3) - 0.5) * 3.0);
          vec3 col = mix(butter, paper, side);
          // floral swirls on the paper
          float sw = n2(p * 1.3) + 0.5 * n2(p * 3.1);
          col = mix(col, teal, smoothstep(0.95, 1.1, sw) * side);
          col = mix(col, pink, smoothstep(9.0, 0.0, length(p - vec2(-1.0, 1.5))) * 0.35);
          col *= 0.85 + 0.15 * smoothstep(-14.0, 8.0, p.y);
          return col;
        }
        void main() {
          float ppt = shPPT(vView);
          float k = shAmount(ppt, 1.0);
          vec3 col = paint(vP);
          if (k > 0.001) {
            vec4 v = shVoro(vP, shCell(ppt));
            vec3 s = paint(v.xy) * (0.9 + 0.2 * v.w) * mix(0.8, 1.0, smoothstep(0.0, 0.1, v.z));
            col = mix(col, s, k);
          }
          gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
        }
      `,
    })
  );
  room.position.set(0, -2, -7);
  scene.add(room);

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

  function pose(p) {
    const studio = p >= STUDIO_AT;
    figure.visible = room.visible = !studio;
    studioCam.group.visible = backdrop.visible = studio;
    // she lowers the camera: the forearm swings down about the elbow, out of frame
    const a = studio ? 0 : smootherstep(p, 0.05, 0.28);
    arm.rotation.set(0.35 * a, -0.15 * a, -1.45 * a);
  }

  // world positions on the studio camera
  studioCam.group.updateMatrixWorld(true);
  const onStudio = (local) => studioCam.group.localToWorld(local.clone());
  const LAMP = onStudio(studioCam.lampLocal);
  const CAM_W = onStudio(V3(0, 0, 0));
  const LCD_W = studioCam.lcdMesh.getWorldPosition(V3());
  const EYE_FRONT = VA(P.eyeL).add(V3(0, 0, P.eyeRadius));

  let keys = [];
  let aspect = 1;
  const fit = (w, h) => Math.max(h / 2 / T, w / 2 / (T * aspect));
  const CUTS = [0.74, 0.885];

  function buildPath() {
    const k = (p, look, dir, dist) => ({ p, look: look.clone(), dir: dir.clone().normalize(), dist });
    const Z = V3(0, 0, 1);
    keys = [
      // her, holding the camera up at us; framed so face, camera and hand all read
      k(0.0, V3(-0.7, -0.9, 0.8), V3(0.06, 0.03, 1), fit(10.5, 9.5)),
      k(0.16, V3(-0.1, -0.6, 1.0), V3(0.05, 0.02, 1), fit(7.4, 7.4)),
      k(0.3, V3(0.05, -0.3, 1.3), V3(0.1, 0.03, 1), fit(4.6, 5.4)),
      k(0.44, V3(0.05, 0.1, 1.55), V3(0.06, 0.03, 1), fit(2.8, 1.2)),
      k(0.56, EYE_FRONT, V3(0.03, 0.01, 1), fit(0.95, 0.5)),
      k(0.66, EYE_FRONT, Z, 0.3),
      k(0.74, EYE_FRONT, Z, 0.012),
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

  // the whole back, face on, so its buttons are in reach
  function lcdPose(outPos, outLook) {
    outLook.copy(CAM_W);
    outPos.copy(CAM_W).add(V3(0, 0, -fit(CW * STUDIO_SCALE * 1.08, CH * STUDIO_SCALE * 1.12)));
  }

  function enterFocus() {
    if (focus.on) return;
    focus.on = true;
    focus.savedY = scrollY;
    document.body.style.top = `-${focus.savedY}px`;
    document.body.classList.add("j-locked");
    journey.classList.add("focused");
    songChip();
    dirty = true;
  }

  function exitFocus() {
    if (!focus.on) return;
    focus.on = false;
    leaveRec();
    window.KimayaSongs?.pause();
    songChip();
    pin.style.cursor = "";
    document.body.classList.remove("j-locked");
    document.body.style.top = "";
    scrollTo(0, focus.savedY);
    journey.classList.remove("focused");
    dirty = true;
  }

  // in focus mode the camera's own buttons drive it
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function hitButton(e) {
    const r = pin.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    view.updateMatrixWorld();
    ray.setFromCamera(ndc, view);
    return ray.intersectObjects(studioCam.buttons, false)[0] || null;
  }

  function press(hit) {
    const btn = hit.object;
    const action = btn.userData.action;
    // a little travel, like a real button
    btn.position.z -= 0.012;
    setTimeout(() => { btn.position.z += 0.012; dirty = true; }, 140);
    dirty = true;

    if (action === "wheel") {
      // left / right half of the wheel; back-group x grows to our right
      const local = btn.parent.worldToLocal(hit.point.clone());
      if (rec.mode === "play") flip(local.x > btn.position.x ? 1 : -1);
    } else if (action === "ok") {
      if (rec.mode === "play") flip(1);
      else if (rec.mode === "intro") openCamera();
      else if (rec.mode === "live") shutter();
    } else if (action === "play" || action === "home") {
      if (rec.mode !== "play") leaveRec();
    } else if (action === "rec") {
      if (rec.mode === "play") setMode("intro");
      else leaveRec();
    } else if (action === "shutter") {
      if (rec.mode === "play") setMode("intro");
      else if (rec.mode === "intro") openCamera();
      else if (rec.mode === "live") shutter();
    } else if (action === "menu") {
      exitFocus();
    }
  }

  pin.addEventListener("pointermove", (e) => {
    if (focus.on) pin.style.cursor = hitButton(e) ? "pointer" : "default";
  });
  pin.addEventListener("click", (e) => {
    if (!focus.on || e.target.closest("button, a, input, textarea, form")) return;
    const hit = hitButton(e);
    if (hit) press(hit);
  });

  journey.querySelector(".j-focus-btn")?.addEventListener("click", (e) => { e.stopPropagation(); enterFocus(); });
  journey.querySelector(".j-exit")?.addEventListener("click", exitFocus);
  journey.querySelector(".j-prev")?.addEventListener("click", () => flip(-1));
  journey.querySelector(".j-next")?.addEventListener("click", () => flip(1));
  addEventListener("keydown", (e) => {
    if (!focus.on) return;
    if (e.target.closest?.("input, textarea")) return;
    if (e.key === "Escape") exitFocus();
    if (rec.mode === "play" && e.key === "ArrowLeft") flip(-1);
    if (rec.mode === "play" && e.key === "ArrowRight") flip(1);
    if (rec.mode === "live" && e.key === " ") { e.preventDefault(); shutter(); }
  });

  // ---------- REC: the camera is the booth ----------
  // play -> intro -> live -> count -> (rec) -> review -> sending -> sent

  const rec = { mode: "play", movie: false, stream: null, still: null, photo: null, clip: null, clipURL: "", takenOn: "", count: 0, recStart: 0 };
  const video = Object.assign(document.createElement("video"), { playsInline: true, muted: true, autoplay: true });
  const clipVideo = Object.assign(document.createElement("video"), { playsInline: true, muted: true, loop: true });
  const white = journey.querySelector(".j-white");
  const ui = {
    err: journey.querySelector(".j-err"),
    name: journey.querySelector(".j-name"),
    msg: journey.querySelector(".j-msg"),
    left: journey.querySelector(".j-left"),
    movie: journey.querySelector(".j-movie"),
    upload: journey.querySelector(".j-upload"),
    file: journey.querySelector(".j-file"),
    send: journey.querySelector(".j-send"),
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function setMode(mode) {
    rec.mode = mode;
    journey.dataset.lcd = mode;
    songChip();
    if (ui.err) ui.err.textContent = "";
    drawLCD();
    dirty = true;
  }

  function stopCamera() {
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    rec.stream = null;
    video.srcObject = null;
  }

  function clearShot() {
    if (rec.clipURL) URL.revokeObjectURL(rec.clipURL);
    clipVideo.pause();
    clipVideo.removeAttribute("src");
    Object.assign(rec, { still: null, photo: null, clip: null, clipURL: "", takenOn: "" });
  }

  function leaveRec() {
    stopCamera();
    clearShot();
    setMode("play");
  }

  async function openCamera() {
    clearShot();
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      video.srcObject = rec.stream;
      await video.play();
      setMode("live");
    } catch {
      setMode("intro");
      ui.err.textContent = "camera blocked. allow camera access and try again.";
    }
  }

  // same look as the old booth: mirrored 640x480, hand-done ccd grade, orange stamp
  function grab(source) {
    const W = 640, H = 480;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");
    const vw = source.videoWidth, vh = source.videoHeight;
    const s = Math.max(W / vw, H / vh);
    g.save();
    g.translate(W, 0);
    g.scale(-1, 1);
    g.drawImage(source, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
    g.restore();
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], gr = d[i + 1], b = d[i + 2];
      const l = 0.299 * r + 0.587 * gr + 0.114 * b;
      r = l + (r - l) * 1.2; gr = l + (gr - l) * 1.2; b = l + (b - l) * 1.2;
      d[i] = (r - 128) * 1.1 + 134; d[i + 1] = (gr - 128) * 1.1 + 130; d[i + 2] = (b - 128) * 1.1 + 122;
    }
    g.putImageData(img, 0, 0);
    g.font = '30px "VT323", monospace';
    g.textAlign = "right";
    g.textBaseline = "bottom";
    g.shadowColor = "rgba(255, 90, 0, .9)";
    g.shadowBlur = 8;
    g.fillStyle = "#ff8a1f";
    g.fillText(stampOf(new Date()), W - 18, H - 12);
    return c;
  }

  const toJpeg = (c, q = 0.85) =>
    new Promise((resolve) => c.toBlob((b) => (b.size > 190 * 1024 && q > 0.5 ? resolve(toJpeg(c, q - 0.1)) : resolve(b)), "image/jpeg", q));

  async function shutter() {
    if (rec.mode !== "live") return;
    setMode("count");
    for (const n of [3, 2, 1]) {
      rec.count = n;
      drawLCD();
      await wait(700);
    }
    rec.count = 0;

    if (rec.movie && window.KimayaClips?.supported()) {
      setMode("rec");
      rec.recStart = performance.now();
      try {
        rec.clip = await window.KimayaClips.record(rec.stream, {
          video,
          seconds: 3,
          onstart: () => { rec.still = grab(video); },
        });
        rec.clipURL = URL.createObjectURL(rec.clip);
        clipVideo.src = rec.clipURL;
        clipVideo.play().catch(() => {});
      } catch (err) {
        ui.err.textContent = `${err.message || err}.`;
        setMode("live");
        return;
      }
    } else {
      // the screen is the flash: hold white so it actually lights the face, then grab
      flashT = 1;
      white?.classList.add("on");
      await wait(220);
      rec.still = grab(video);
      await wait(120);
      white?.classList.remove("on");
    }
    rec.photo = await toJpeg(rec.still);
    stopCamera();
    setMode("review");
    ui.name?.focus();
  }

  async function upload(file) {
    if (!file || !window.KimayaUploads) return;
    clearShot();
    try {
      const out = await window.KimayaUploads.prepare(file);
      rec.photo = out.photo;
      rec.clip = out.clip || null;
      rec.takenOn = out.takenOn || "";
      rec.still = await createImageBitmap(out.photo);
      if (rec.clip) {
        rec.clipURL = URL.createObjectURL(rec.clip);
        clipVideo.src = rec.clipURL;
        clipVideo.play().catch(() => {});
      }
      stopCamera();
      setMode("review");
      ui.name?.focus();
    } catch (err) {
      ui.err.textContent = `${err.message || err}.`;
    }
  }

  async function send(e) {
    e.preventDefault();
    const name = ui.name.value.trim();
    const message = ui.msg.value.trim();
    if (!rec.photo || !name || !message) return;
    ui.send.disabled = true;
    setMode("sending");
    try {
      await window.KimayaGuestbook.post({ name, message, photo: rec.photo, clip: rec.clip, takenOn: rec.takenOn });
      ui.name.value = "";
      ui.msg.value = "";
      ui.left.textContent = "140";
      clearShot();
      setMode("sent");
    } catch (err) {
      setMode("review");
      ui.err.textContent = `${err.message || err}.`;
    } finally {
      ui.send.disabled = false;
    }
  }

  function cover(g, src, sw, sh, W, H, mirror = false) {
    const s = Math.max(W / sw, H / sh);
    g.save();
    if (mirror) { g.translate(W, 0); g.scale(-1, 1); }
    g.drawImage(src, (W - sw * s) / 2, (H - sh * s) / 2, sw * s, sh * s);
    g.restore();
  }

  function hudText(g, text, x, y, align = "left", color = "#9fe8c8", size = 30) {
    g.font = `${size}px "VT323", monospace`;
    g.textAlign = align;
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  function drawRec(g, W, H) {
    const m = rec.mode;
    const blink = Math.floor(performance.now() / 500) % 2 === 0;

    if ((m === "live" || m === "count" || m === "rec") && video.videoWidth) cover(g, video, video.videoWidth, video.videoHeight, W, H, true);
    if (m === "review" || m === "sending") {
      if (rec.clip && clipVideo.videoWidth) cover(g, clipVideo, clipVideo.videoWidth, clipVideo.videoHeight, W, H);
      else if (rec.still) cover(g, rec.still, rec.still.width, rec.still.height, W, H);
    }

    if (m === "intro" || m === "sent") {
      g.fillStyle = "#050607";
      g.fillRect(0, 0, W, H);
      if (m === "intro") {
        hudText(g, "● REC", W / 2, H / 2 - 70, "center", "#ff4a3d", 44);
        hudText(g, "take a picture, leave a note.", W / 2, H / 2 - 14, "center", "#e9e6df", 30);
        hudText(g, "it goes public once kimaya says yes.", W / 2, H / 2 + 26, "center", "#8a8780", 24);
      } else {
        hudText(g, "SAVED", W / 2, H / 2 - 20, "center", "#9fe8c8", 56);
        hudText(g, "it'll show up once kimaya says yes.", W / 2, H / 2 + 30, "center", "#8a8780", 26);
      }
      return;
    }

    // viewfinder hud
    g.fillStyle = "rgba(0,0,0,.3)";
    g.fillRect(0, 0, W, 44);
    if (m === "rec") {
      const secs = Math.min(3, Math.floor((performance.now() - rec.recStart) / 1000));
      hudText(g, `${blink ? "●" : " "} REC 00:0${secs}`, 16, 23, "left", "#ff4a3d");
    } else if (m === "review" || m === "sending") {
      hudText(g, m === "sending" ? "SENDING…" : "▶ REVIEW", 16, 23);
    } else {
      hudText(g, rec.movie ? "● MOVIE  320" : "■ 640x480 FINE", 16, 23);
    }
    hudText(g, "▮▮▮", W - 16, 23, "right");
    if (m === "live" || m === "count") {
      // focus brackets
      g.strokeStyle = m === "count" ? "#6dff9e" : "#e9e6df";
      g.lineWidth = 3;
      const bw = 120, bh = 90, cx = W / 2, cy = H / 2, k = 18;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
        const x = cx + sx * bw / 2, y = cy + sy * bh / 2;
        g.beginPath();
        g.moveTo(x, y - sy * k);
        g.lineTo(x, y);
        g.lineTo(x - sx * k, y);
        g.stroke();
      });
    }
    if (m === "count" && rec.count) hudText(g, String(rec.count), W / 2, H / 2, "center", "#ffffff", 150);
    hudText(g, stampOf(new Date()), W - 16, H - 30, "right", "#ff8a1f", 34);
  }

  // the lcd redraws every frame while it's showing something live
  const lcdLive = () =>
    ["live", "count", "rec"].includes(rec.mode) ||
    (rec.mode === "review" && rec.clip) ||
    (rec.mode === "play" && (focus.on || prog > 0.88) && gallery.items[gallery.index]?.clip);

  journey.querySelector(".j-mode-play")?.addEventListener("click", leaveRec);
  journey.querySelector(".j-mode-rec")?.addEventListener("click", () => { if (rec.mode === "play") setMode("intro"); });
  journey.querySelector(".j-open")?.addEventListener("click", openCamera);
  journey.querySelector(".j-shutter")?.addEventListener("click", shutter);
  journey.querySelector(".j-retake")?.addEventListener("click", openCamera);
  journey.querySelector(".j-again")?.addEventListener("click", () => setMode("intro"));
  journey.querySelector(".j-form")?.addEventListener("submit", send);
  ui.msg?.addEventListener("input", () => { ui.left.textContent = 140 - ui.msg.value.length; });
  ui.movie?.addEventListener("click", () => {
    rec.movie = !rec.movie;
    ui.movie.textContent = rec.movie ? "● MOVIE" : "■ PHOTO";
    drawLCD();
    dirty = true;
  });
  if (ui.movie && !window.KimayaClips?.supported()) ui.movie.hidden = true;
  if (ui.upload) {
    ui.upload.hidden = !window.KimayaUploads;
    ui.upload.addEventListener("click", () => ui.file.click());
    ui.file.addEventListener("change", () => { upload(ui.file.files[0]); ui.file.value = ""; });
  }

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

    pose(p);
    const studio = p >= STUDIO_AT;

    const close = studio
      ? 0.55 + 0.35 * smootherstep(p, 0.78, 0.88) - 0.3 * smootherstep(p, 0.89, 0.97)
      : smootherstep(p, 0.08, 0.5);
    post.uniforms.uPaint.value = (0.12 + 0.88 * close) * (1 - fe);
    shared.uShard.value = 1 - fe;

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
    if (!focus.on && rec.mode === "play" && prog > 0.9 && now - gallery.lastFlip > 3500) flip(1);
    if (lcdLive()) { drawLCD(); dirty = true; }

    const boil = !calm && now - lastBoil > 1000 / 12;
    if (boil) { lastBoil = now; frameNo++; }
    if (moving || focusMoving || boil || dirty || flashT > 0) {
      dirty = false;
      draw();
    }
  })(performance.now());
}
