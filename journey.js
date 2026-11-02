// scroll journey: kimaya holding a digicam at us -> camera drops away -> her face ->
// her eyes -> into the pupil -> out through the camera's lens -> back where we began.
//
// look: photographic from afar, and the closer you get the more the surface breaks into
// lit voronoi shards (texture-space, so it follows real magnification). painted pass on top.

const journey = document.getElementById("journey");
const pin = journey.querySelector(".journey-pin");

try {
  const THREE = await import("three");
  const { RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js");
  const [map, depth] = await Promise.all([loadTex(THREE, "assets/kimaya.jpg"), loadImage("assets/kimaya-depth.png")]);
  init(THREE, RoundedBoxGeometry, map, depth);
  journey.classList.add("live");
} catch (err) {
  console.warn("[journey] falling back to still:", err);
  journey.classList.add("dead");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function loadTex(THREE, src) {
  const tex = new THREE.Texture(await loadImage(src));
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function init(THREE, RoundedBoxGeometry, map, depthImg) {
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { smootherstep, lerp, clamp } = THREE.MathUtils;

  // ---------- photo geometry ----------
  // the processed photo is 1600x860; 100 texels per world unit
  const TEX = new THREE.Vector2(1600, 860);
  const PW = 16, PH = 8.6, DS = 1.6;
  const px = (x, y) => new THREE.Vector2(x / TEX.x, 1 - y / TEX.y); // image px -> uv

  const EYE = px(713, 317);
  const FACE = px(650, 430);
  const BETWEEN = px(630, 330);

  // read the depth map on the cpu too, so camera targets sit on the surface
  const dc = document.createElement("canvas");
  dc.width = depthImg.width;
  dc.height = depthImg.height;
  const dctx = dc.getContext("2d");
  dctx.drawImage(depthImg, 0, 0);
  const dpx = dctx.getImageData(0, 0, dc.width, dc.height).data;
  function depthAt(uv) {
    const x = clamp(Math.round(uv.x * (dc.width - 1)), 0, dc.width - 1);
    const y = clamp(Math.round((1 - uv.y) * (dc.height - 1)), 0, dc.height - 1);
    return dpx[(y * dc.width + x) * 4] / 255;
  }
  const world = (uv) => new THREE.Vector3((uv.x - 0.5) * PW, (uv.y - 0.5) * PH, depthAt(uv) * DS);

  // ---------- renderer ----------

  const hex = (h) => {
    const n = parseInt(h.slice(1), 16);
    return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setClearColor(0x000000);
  pin.prepend(renderer.domElement);
  const rt = new THREE.WebGLRenderTarget(1, 1);
  const scene = new THREE.Scene();
  const FOV = 35;
  const T = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const view = new THREE.PerspectiveCamera(FOV, 1, 0.004, 100);

  const shared = {
    uSeed: { value: 0 },
    uKey: { value: new THREE.Vector3(-0.65, 0.7, 0.35).normalize() },
    uRimDir: { value: new THREE.Vector3(0.9, 0.35, -0.5).normalize() },
    uRim: { value: hex("#ff9b52") },
    uBand: { value: 0 },
  };

  const NOISE = /* glsl */ `
    float hash(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    vec2 hash2(vec2 p) {
      p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
      return fract(sin(p) * 43758.5453);
    }
    float noise(vec3 x) {
      vec3 i = floor(x), f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
                     mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                     mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
      float v = 0.0, a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
  `;

  // ---------- the portrait: displaced photo that shatters with magnification ----------

  const depthTex = new THREE.Texture(depthImg);
  depthTex.needsUpdate = true;

  const portraitUniforms = {
    uMap: { value: map },
    uDepth: { value: depthTex },
    uDS: { value: DS },
    uTex: { value: TEX },
    uEye: { value: EYE },
    uIris: { value: 0 },
    uDive: { value: 0 },
  };

  const portrait = new THREE.Mesh(
    new THREE.PlaneGeometry(PW, PH, 160, 86),
    new THREE.ShaderMaterial({
      uniforms: portraitUniforms,
      vertexShader: /* glsl */ `
        uniform sampler2D uDepth; uniform float uDS;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          p.z += texture2D(uDepth, uv).r * uDS;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; uniform vec2 uTex, uEye; uniform float uIris, uDive;
        varying vec2 vUv;
        ${NOISE}

        // texture-space voronoi: seed position (texels), edge metric, cell random
        vec4 voro(vec2 t, float cell) {
          vec2 g = t / cell, i = floor(g), f = fract(g);
          float d1 = 8.0, d2 = 8.0; vec2 best = vec2(0.0), id = vec2(0.0);
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 o = vec2(float(x), float(y));
              vec2 h = hash2(i + o) * 0.9 + 0.05;
              vec2 r = o + h - f;
              float d = dot(r, r);
              if (d < d1) { d2 = d1; d1 = d; best = (i + o + h) * cell; id = i + o; }
              else if (d < d2) { d2 = d; }
            }
          }
          return vec4(best, sqrt(d2) - sqrt(d1), hash2(id + 7.0).x);
        }

        // one shard: flat colour from its seed, lit as a tilted facet, dark seam
        vec3 shard(vec2 t, float cell) {
          vec4 v = voro(t, cell);
          vec3 c = texture2D(uMap, v.xy / uTex).rgb;
          vec2 tilt = hash2(v.xy * 0.37 + cell) - 0.5;
          vec3 n = normalize(vec3(tilt * 0.55, 1.0));
          float lit = dot(n, normalize(vec3(-0.5, 0.6, 0.65)));
          c *= 0.86 + 0.22 * lit;
          c = mix(c, c * vec3(1.08, 0.98, 0.9), step(0.97, lit));       // warm facet catching the key
          c *= mix(0.84, 1.0, smoothstep(0.0, 0.1, v.z));               // seams
          return mix(c, floor(c * 9.0 + 0.5) / 9.0, 0.3);
        }

        // a faceted iris drawn on top of the (tiny, blurry) real one, octagonal pupil
        vec4 iris(vec2 d) {
          const float RI = 10.5, RP = 3.9;
          float r = length(d);
          float rn = r / RI;
          float a = atan(d.y, d.x);
          float ring = floor(rn * 7.0);
          float wedge = floor((a / 6.2831853 + 0.5) * 44.0);
          float h = hash(vec3(wedge, ring, 3.0));
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
          // lids only matter while the whole eye is in view
          return vec4(c, (1.0 - smoothstep(RI - edge, RI + edge, r)) * max(lids, uDive));
        }

        void main() {
          vec2 t = vUv * uTex;
          vec2 fw = fwidth(t);
          float ppt = 1.0 / max(max(fw.x, fw.y), 1e-5); // screen pixels per texel

          vec3 col = texture2D(uMap, vUv).rgb;

          // far: the photo. close: shards, splitting finer as you keep going
          float k = smoothstep(1.3, 4.5, ppt);
          if (k > 0.0) {
            float lv = clamp(log2(ppt / 8.0), 0.0, 5.0);
            float L = floor(lv);
            float cA = 9.0 / exp2(L);
            vec3 s = mix(shard(t, cA), shard(t, cA * 0.5), smoothstep(0.55, 1.0, fract(lv)));
            col = mix(col, s, k);
          }

          if (uIris > 0.0) {
            vec4 ir = iris((vUv - uEye) * uTex);
            col = mix(col, ir.rgb, ir.a * uIris);
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
  );
  scene.add(portrait);

  // ---------- the digicam ----------

  function paint({ shadow, mid, base, high, metal = 0, scale = 5, emit = null }) {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        uShadow: { value: hex(shadow) },
        uMid: { value: hex(mid) },
        uBase: { value: hex(base) },
        uHigh: { value: hex(high) },
        uMetal: { value: metal },
        uScale: { value: scale },
        uEmit: emit || { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vW; varying vec3 vO;
        void main() {
          vO = position;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uShadow, uMid, uBase, uHigh, uRim, uKey, uRimDir;
        uniform float uSeed, uMetal, uScale, uEmit, uBand;
        varying vec3 vN; varying vec3 vW; varying vec3 vO;
        ${NOISE}
        void main() {
          vec3 N = normalize(vN);
          if (!gl_FrontFacing) N = -N;
          vec3 V = normalize(cameraPosition - vW);
          float n = (fbm(vO * vec3(uScale, uScale * 2.5, uScale) + uSeed * 7.13) - 0.5) * uBand;

          float d = dot(N, uKey) * 0.45 + 0.4 + n * 0.22;
          vec3 R = reflect(-V, N);
          float env = smoothstep(-0.02, mix(0.5, 0.1, uBand), R.y - 0.05 + n * 0.3);
          d = mix(d, d * 0.55 + env * 0.5 - 0.05, uMetal);
          d = clamp(d, 0.0, 0.999);

          // smooth ramp when far, four flat bands when close
          vec3 smoothCol = mix(mix(mix(uShadow, uMid, smoothstep(0.0, 0.33, d)), uBase, smoothstep(0.33, 0.66, d)), uHigh, smoothstep(0.66, 1.0, d));
          float b = floor(d * 4.0);
          vec3 bandCol = b < 0.5 ? uShadow : b < 1.5 ? uMid : b < 2.5 ? uBase : uHigh;
          vec3 col = mix(smoothCol, bandCol, uBand);

          vec3 H = normalize(uKey + V);
          float sp = pow(max(dot(N, H), 0.0), 60.0) + n * 0.35;
          col = mix(col, vec3(1.0, 0.98, 0.93), mix(smoothstep(0.3, 0.8, sp), step(0.55, sp), uBand) * (0.35 + 0.65 * uMetal));

          float fr = pow(1.0 - max(dot(N, V), 0.0), 2.5) * (dot(N, uRimDir) * 0.5 + 0.5) + n * 0.25;
          col = mix(col, uRim, mix(smoothstep(0.3, 0.6, fr) * 0.5, step(0.42, fr) * 0.85, uBand));

          col = mix(col, vec3(1.0, 0.97, 0.9), uEmit);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
  }

  const flashGlow = { value: 0 };
  const M = {
    body: paint({ shadow: "#2a2d48", mid: "#7a809e", base: "#b4b8c6", high: "#ebe4d6", metal: 0.7 }),
    ring: paint({ shadow: "#171a2e", mid: "#454b66", base: "#8d93a8", high: "#e4d8c2", metal: 1, scale: 9 }),
    glass: paint({ shadow: "#020305", mid: "#070d12", base: "#12262b", high: "#5c9a8d", metal: 1, scale: 3 }),
    flash: paint({ shadow: "#7a7468", mid: "#b9b2a2", base: "#e6dfcd", high: "#fff8e8", scale: 12, emit: flashGlow }),
    amber: paint({ shadow: "#24140a", mid: "#4a2c14", base: "#7a4a1c", high: "#e0a060", metal: 0.6 }),
  };

  const cam = new THREE.Group();
  scene.add(cam);
  const CW = 3.4, CH = 2.0, CD = 0.75, FRONT = CD / 2;
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = cam) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const disc = (r, h, segs = 64) => new THREE.CylinderGeometry(r, r, h, segs).rotateX(Math.PI / 2);

  add(new RoundedBoxGeometry(CW, CH, CD, 8, 0.3), M.body);
  const lens = new THREE.Group();
  lens.position.set(0.62, -0.08, FRONT);
  cam.add(lens);
  add(disc(0.86, 0.06), M.ring, 0, 0, 0.03, lens);
  add(disc(0.7, 0.22), M.body, 0, 0, 0.11, lens);
  add(disc(0.58, 0.36), M.ring, 0, 0, 0.18, lens);
  add(disc(0.48, 0.5), M.body, 0, 0, 0.25, lens);
  add(new THREE.TorusGeometry(0.34, 0.04, 12, 48), M.ring, 0, 0, 0.5, lens);
  const glass = add(disc(0.26, 0.02, 8).rotateZ(Math.PI / 8), M.glass, 0, 0, 0.5, lens);
  add(new RoundedBoxGeometry(0.74, 0.2, 0.06, 2, 0.05), M.flash, -0.25, 0.64, FRONT);
  add(new THREE.SphereGeometry(0.05, 16, 12), M.amber, 0.38, 0.66, FRONT);
  add(new THREE.CylinderGeometry(0.23, 0.23, 0.05, 40), M.ring, -1.05, CH / 2 + 0.02, 0);
  add(new THREE.CylinderGeometry(0.16, 0.17, 0.1, 40), M.body, -1.05, CH / 2 + 0.06, 0);

  // held where her phone was, lens at us
  const HELD = { pos: new THREE.Vector3(3.05, -1.75, 1.15), rot: new THREE.Euler(0.1, -0.32, 0.06), scale: 1.45 };
  const ASIDE = { pos: new THREE.Vector3(9.5, -7.2, 2.2), rot: new THREE.Euler(0.7, -1.25, -0.5) };

  function poseCam(p) {
    const a = p < 0.85 ? smootherstep(p, 0.05, 0.3) : 0;
    cam.scale.setScalar(HELD.scale);
    cam.position.lerpVectors(HELD.pos, ASIDE.pos, a);
    cam.rotation.set(
      lerp(HELD.rot.x, ASIDE.rot.x, a),
      lerp(HELD.rot.y, ASIDE.rot.y, a),
      lerp(HELD.rot.z, ASIDE.rot.z, a)
    );
    cam.visible = a < 0.999;
  }

  // where the glass sits and which way it faces, in the held pose
  poseCam(0);
  cam.updateMatrixWorld(true);
  const LENS = glass.getWorldPosition(new THREE.Vector3());
  const LENS_AXIS = new THREE.Vector3(0, 0, 1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())).normalize();

  // ---------- paint pass ----------

  const post = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rt.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uSeed: shared.uSeed,
      uPaint: { value: 0 },
      uBlack: { value: 0 },
      uFlash: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene; uniform vec2 uRes; uniform float uSeed, uPaint, uBlack, uFlash;
      varying vec2 vUv;
      ${NOISE}
      const int R = 3;
      vec3 kuwahara(vec2 uv) {
        vec2 px = 1.0 / uRes;
        vec3 m0 = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0), m3 = vec3(0.0);
        vec3 s0 = vec3(0.0), s1 = vec3(0.0), s2 = vec3(0.0), s3 = vec3(0.0);
        for (int j = -R; j <= R; j++) {
          for (int i = -R; i <= R; i++) {
            vec3 c = texture2D(tScene, uv + vec2(float(i), float(j)) * px).rgb;
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

        vec3 raw = texture2D(tScene, vUv).rgb;
        vec3 col = uPaint > 0.01 ? mix(raw, kuwahara(uv), uPaint) : raw;

        vec2 off = (vUv - 0.5) * px * 6.0;
        col.r = mix(col.r, texture2D(tScene, uv + off).r, 0.35);
        col.b = mix(col.b, texture2D(tScene, uv - off).b, 0.35);

        float vig = smoothstep(1.1, 0.35, length((vUv - 0.5) * vec2(1.1, 1.0)));
        col *= mix(0.6, 1.0, vig);
        col += (hash(vec3(vUv * uRes, uSeed * 13.0)) - 0.5) * 0.06;
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

  // ---------- the path ----------
  // each key: what we look at, which way we're backed off from it, how far.
  // distance interpolates in log space so the push into the eye feels even.

  let keys = [];
  let aspect = 1;
  const fit = (w, h) => Math.max(h / 2 / T, w / 2 / (T * aspect));

  function buildPath() {
    const cover = Math.min(PH / 2 / T, PW / 2 / (T * aspect)) * 0.97;
    const visW = 2 * cover * T * aspect;
    const startX = clamp(0.9, -PW / 2 + visW / 2, PW / 2 - visW / 2);
    const start = { look: new THREE.Vector3(startX, 0, 0), dir: new THREE.Vector3(0, 0, 1), dist: cover };
    const face = world(FACE);
    const between = world(BETWEEN);
    const eye = world(EYE);
    const k = (p, look, dir, dist) => ({ p, look, dir: dir.clone().normalize(), dist });

    keys = [
      k(0.0, start.look, start.dir, start.dist),
      k(0.18, new THREE.Vector3(lerp(startX, face.x, 0.6), face.y * 0.5, face.z * 0.5), new THREE.Vector3(0.04, 0, 1), cover * 0.8),
      k(0.34, face.clone().add(new THREE.Vector3(-0.5, 0, 0)), new THREE.Vector3(0.1, 0.02, 1), fit(4.6, 4.8)),
      k(0.5, between, new THREE.Vector3(0.05, 0.03, 1), fit(2.9, 1.3)),
      k(0.64, eye, new THREE.Vector3(0.02, 0.01, 1), fit(0.95, 0.5)),
      k(0.78, eye, new THREE.Vector3(0, 0, 1), 0.17),
      k(0.845, eye, new THREE.Vector3(0, 0, 1), 0.012),
      // cut: we come out of the lens
      k(0.855, LENS, LENS_AXIS, 0.06),
      k(0.93, LENS, LENS_AXIS, 1.9),
      k(1.0, start.look, start.dir, start.dist),
    ];
  }

  const tmpLook = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  function poseView(p) {
    let i = 0;
    while (i < keys.length - 2 && p > keys[i + 1].p) i++;
    const a = keys[i], b = keys[i + 1];
    const t = a.p === b.p ? 1 : smootherstep(p, a.p, b.p);
    // the black gap between the pupil and the lens is a hard cut
    const cut = a.p === 0.845;
    const u = cut ? (p < b.p ? 0 : 1) : t;
    tmpLook.lerpVectors(a.look, b.look, u);
    tmpDir.lerpVectors(a.dir, b.dir, u).normalize();
    const dist = Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), u));
    view.position.copy(tmpLook).addScaledVector(tmpDir, dist);
    view.lookAt(tmpLook);
  }

  // ---------- frame ----------

  const hud = {
    zoom: journey.querySelector(".j-zoom i"),
    hint: journey.querySelector(".j-hint"),
    focus: journey.querySelector(".j-focus"),
  };

  let target = 0, prog = 0, frameNo = 0, flashT = 0, dirty = true;

  // dev: ?p=0.5 freezes the journey at that point
  const pinned = new URLSearchParams(location.search).get("p");

  function readScroll() {
    if (pinned !== null) { target = clamp(parseFloat(pinned) || 0, 0, 1); return; }
    const r = journey.getBoundingClientRect();
    const span = r.height - innerHeight;
    target = span > 0 ? clamp(-r.top / span, 0, 1) : 0;
  }

  function draw() {
    const p = prog;
    journey.progress = p; // handy in devtools
    poseCam(p);
    poseView(p);

    // how stylised: low far out, full in close, easing back as we leave the lens
    const close = p < 0.85 ? smootherstep(p, 0.08, 0.5) : 1 - smootherstep(p, 0.88, 1.0);
    post.uniforms.uPaint.value = 0.12 + 0.88 * close;
    shared.uBand.value = close;
    portraitUniforms.uIris.value = p < 0.85 ? smootherstep(p, 0.5, 0.62) : 0;
    portraitUniforms.uDive.value = smootherstep(p, 0.7, 0.78);
    post.uniforms.uBlack.value = p < 0.85 ? smootherstep(p, 0.8, 0.845) : 1 - smootherstep(p, 0.855, 0.885);

    shared.uSeed.value = calm ? 0 : frameNo % 3;
    flashGlow.value = flashT;
    post.uniforms.uFlash.value = flashT * 0.85;
    flashT = Math.max(0, flashT - 0.25);

    renderer.setRenderTarget(rt);
    renderer.render(scene, view);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);

    // viewfinder hud
    if (hud.zoom) hud.zoom.style.width = `${Math.round(Math.min(p / 0.845, 1) * 100)}%`;
    if (hud.hint) hud.hint.hidden = p > 0.02;
    if (hud.focus) hud.focus.classList.toggle("locked", (p > 0.3 && p < 0.8) || p > 0.95);
  }

  // render resolution drops on slow gpus; the painted look survives upscaling
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
    aspect = w / h;
    view.aspect = aspect;
    view.updateProjectionMatrix();
    buildPath();
    dirty = true;
    draw();
  }

  // ---------- input ----------

  pin.addEventListener("click", () => {
    if (prog > 0.12 && prog < 0.95) return;
    flashT = 1;
    dirty = true;
    const page = document.querySelector(".flash");
    if (page) {
      page.classList.remove("on");
      void page.offsetWidth;
      page.classList.add("on");
    }
    setTimeout(() => window.dispatchEvent(new Event("kimaya:booth")), 350);
  });

  addEventListener("scroll", () => { readScroll(); dirty = true; }, { passive: true });
  new ResizeObserver(resize).observe(pin);
  readScroll();
  prog = calm ? 0 : target;
  resize();

  if (calm) return;

  let lastBoil = 0;
  let lastT = performance.now();
  const born = lastT;
  let slow = 0;
  let onScreen = true;
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(journey);

  (function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - lastT) / 1000, 0.5);
    lastT = now;
    if (!onScreen || document.hidden) return;

    // sustained slow frames: render smaller; sustained fast: claw it back.
    // skip the first couple of seconds, shader compiles stall everyone.
    if (now - born > 2500) {
      slow = dt > 0.045 ? slow + 1 : dt < 0.022 ? slow - 1 : slow;
      if (slow > 4 && scale > 0.35) {
        scale = Math.max(0.35, scale * 0.7);
        slow = 0;
        resize();
      } else if (slow < -90 && scale < maxScale) {
        scale = Math.min(maxScale, scale * 1.25);
        slow = 0;
        resize();
      }
    }

    const moving = Math.abs(target - prog) > 1e-4;
    if (moving) prog += (target - prog) * (1 - Math.exp(-dt * 7));
    const boil = now - lastBoil > 1000 / 12;
    if (boil) { lastBoil = now; frameNo++; }
    if (moving || boil || dirty || flashT > 0) {
      dirty = false;
      draw();
    }
  })(performance.now());
}
