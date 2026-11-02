// painterly 3D digicam for the hero.
// look: banded light with brushed band edges, cool shadows, warm rim,
// kuwahara paint pass, animated "on twos" (12fps) so the strokes boil.
// if anything here fails the stage hides itself and the rest of the site carries on.

const stage = document.getElementById("stage");

try {
  const THREE = await import("three");
  const { RoundedBoxGeometry } = await import("three/addons/geometries/RoundedBoxGeometry.js");
  await document.fonts.load('italic 100px "Instrument Serif"').catch(() => {});
  init(THREE, RoundedBoxGeometry);
  stage.classList.remove("dead");
  stage.classList.add("live");
} catch (err) {
  console.warn("[camera] falling back to flat hero:", err);
  stage.classList.add("dead");
}

function init(THREE, RoundedBoxGeometry) {
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FPS = 12;

  // colours are written straight to screen, no colour management
  const hex = (h) => {
    const n = parseInt(h.slice(1), 16);
    return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setClearColor(0x4b524f);
  stage.prepend(renderer.domElement);

  const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });

  const scene = new THREE.Scene();
  const view = new THREE.PerspectiveCamera(28, 1, 0.1, 100);

  // ---------- shared uniforms ----------

  const shared = {
    uSeed: { value: 0 },
    uKey: { value: new THREE.Vector3(-0.65, 0.7, 0.35).normalize() },
    uRimDir: { value: new THREE.Vector3(0.9, 0.35, -0.5).normalize() },
    uRim: { value: hex("#ff9b52") },
  };

  const NOISE = /* glsl */ `
    float hash(vec3 p) {
      p = fract(p * 0.3183099 + 0.1);
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
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

  // ---------- paint material: 4 discrete bands, brushed edges ----------

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
        uniform float uSeed, uMetal, uScale, uEmit;
        varying vec3 vN; varying vec3 vW; varying vec3 vO;
        ${NOISE}
        void main() {
          vec3 N = normalize(vN);
          if (!gl_FrontFacing) N = -N;
          vec3 V = normalize(cameraPosition - vW);

          // stroke field, stretched so it reads like brush drags
          float n = fbm(vO * vec3(uScale, uScale * 2.5, uScale) + uSeed * 7.13) - 0.5;

          float d = dot(N, uKey) * 0.45 + 0.4 + n * 0.22;

          // chrome: horizon reflection split into sky / floor
          vec3 R = reflect(-V, N);
          float env = smoothstep(-0.02, 0.1, R.y - 0.05 + n * 0.3);
          d = mix(d, d * 0.55 + env * 0.5 - 0.05, uMetal);

          float b = floor(clamp(d, 0.0, 0.999) * 4.0);
          vec3 col = b < 0.5 ? uShadow : b < 1.5 ? uMid : b < 2.5 ? uBase : uHigh;

          vec3 H = normalize(uKey + V);
          float sp = pow(max(dot(N, H), 0.0), 60.0) + n * 0.35;
          col = mix(col, vec3(1.0, 0.98, 0.93), step(0.55, sp) * (0.35 + 0.65 * uMetal));

          float fr = pow(1.0 - max(dot(N, V), 0.0), 2.5) * (dot(N, uRimDir) * 0.5 + 0.5) + n * 0.25;
          col = mix(col, uRim, step(0.42, fr) * 0.85);

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
    glass: paint({ shadow: "#04060a", mid: "#0c1a22", base: "#1d3b40", high: "#6fb3a4", metal: 1, scale: 3 }),
    flash: paint({ shadow: "#7a7468", mid: "#b9b2a2", base: "#e6dfcd", high: "#fff8e8", scale: 12, emit: flashGlow }),
    cord: paint({ shadow: "#2c2a30", mid: "#5b5760", base: "#8f8a90", high: "#d2c9c3", scale: 14 }),
    bead: paint({ shadow: "#5d627c", mid: "#a9aab6", base: "#e5e1da", high: "#fffaf0", scale: 4 }),
    amber: paint({ shadow: "#24140a", mid: "#4a2c14", base: "#7a4a1c", high: "#e0a060", metal: 0.6 }),
  };

  // ---------- model: generic silver compact ----------

  const cam = new THREE.Group();
  scene.add(cam);

  const W = 3.4, Ht = 2.0, D = 0.75, FRONT = D / 2;
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = cam) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const disc = (r, h, segs = 64) => new THREE.CylinderGeometry(r, r, h, segs).rotateX(Math.PI / 2);

  add(new RoundedBoxGeometry(W, Ht, D, 8, 0.3), M.body);

  // lens: plate, three stepped barrels, bezel, octagonal glass
  const lens = new THREE.Group();
  lens.position.set(0.62, -0.08, FRONT);
  cam.add(lens);
  add(disc(0.86, 0.06), M.ring, 0, 0, 0.03, lens);
  add(disc(0.7, 0.22), M.body, 0, 0, 0.11, lens);
  add(disc(0.58, 0.36), M.ring, 0, 0, 0.18, lens);
  add(disc(0.48, 0.5), M.body, 0, 0, 0.25, lens);
  add(new THREE.TorusGeometry(0.34, 0.04, 12, 48), M.ring, 0, 0, 0.5, lens);
  add(disc(0.26, 0.02, 8).rotateZ(Math.PI / 8), M.glass, 0, 0, 0.5, lens);

  // front details
  add(new RoundedBoxGeometry(0.74, 0.2, 0.06, 2, 0.05), M.flash, -0.25, 0.64, FRONT);
  add(new THREE.SphereGeometry(0.05, 16, 12), M.amber, 0.38, 0.66, FRONT);

  // top: shutter with ring, power button
  add(new THREE.CylinderGeometry(0.23, 0.23, 0.05, 40), M.ring, -1.05, Ht / 2 + 0.02, 0);
  add(new THREE.CylinderGeometry(0.16, 0.17, 0.1, 40), M.body, -1.05, Ht / 2 + 0.06, 0);
  add(new RoundedBoxGeometry(0.34, 0.06, 0.14, 2, 0.03), M.body, -0.35, Ht / 2 + 0.02, 0);

  // name on the front, where the brand would be
  const label = (() => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 160;
    const g = c.getContext("2d");
    g.fillStyle = "#3a3e56";
    g.font = 'italic 120px "Instrument Serif", Georgia, serif';
    g.textBaseline = "middle";
    g.fillText("kimaya", 16, 84);
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    return new THREE.ShaderMaterial({
      uniforms: { map: { value: tex } },
      transparent: true,
      depthWrite: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D map; varying vec2 vUv;
        void main(){ vec4 t = texture2D(map, vUv); if (t.a < 0.08) discard; gl_FragColor = t; }`,
    });
  })();
  add(new THREE.PlaneGeometry(1.15, 0.36), label, -1.0, -0.12, FRONT + 0.002);

  // wrist strap: two cords and a toggle bead
  [0, 0.07].forEach((dz) => {
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.66, 0.35, dz),
      new THREE.Vector3(-2.0, 0.2, 0.1 + dz),
      new THREE.Vector3(-2.2, -0.25, 0.25 + dz),
      new THREE.Vector3(-2.25, -0.8, 0.35 + dz),
      new THREE.Vector3(-2.15, -1.1, 0.3 + dz),
    ]);
    add(new THREE.TubeGeometry(path, 40, 0.035, 8), M.cord);
  });
  add(new THREE.CapsuleGeometry(0.11, 0.26, 6, 16), M.bead, -2.14, -1.3, 0.34);

  // painted contact shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(6.5, 2.4).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: { ...shared },
      transparent: true,
      depthWrite: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uSeed; varying vec2 vUv;
        ${NOISE}
        void main() {
          vec2 p = (vUv - 0.5) * vec2(1.0, 2.2);
          float a = smoothstep(0.5, 0.05, length(p) + (fbm(vec3(vUv * 9.0, uSeed)) - 0.5) * 0.15);
          a = floor(a * 3.0) / 3.0;
          gl_FragColor = vec4(0.17, 0.18, 0.24, a * 0.55);
        }
      `,
    })
  );
  shadow.position.y = -1.45;
  scene.add(shadow);

  // painted backdrop: olive-grey seamless with a warm bloom behind the subject
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { ...shared, uAspect: { value: 1 } },
      depthWrite: false,
      depthTest: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uSeed, uAspect; varying vec2 vUv;
        ${NOISE}
        void main() {
          vec2 p = vUv;
          float strokes = fbm(vec3(p.x * 2.5 * uAspect, p.y * 16.0, uSeed * 3.0));
          float wash = fbm(vec3(p * 3.0, 1.7));
          vec3 top = vec3(0.50, 0.55, 0.52);
          vec3 low = vec3(0.24, 0.27, 0.28);
          vec3 col = mix(low, top, smoothstep(0.0, 1.0, p.y + (wash - 0.5) * 0.4));
          float glow = smoothstep(0.75, 0.0, length((p - vec2(0.52, 0.55)) * vec2(uAspect, 1.4)));
          col = mix(col, vec3(0.86, 0.68, 0.50), glow * 0.55);
          col += (strokes - 0.5) * 0.12;
          col = floor(col * 9.0 + 0.5) / 9.0 * 0.5 + col * 0.5;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    })
  );
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1;
  scene.add(backdrop);

  // ---------- paint pass: kuwahara + grain + fringe + vignette ----------

  const post = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rt.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uSeed: shared.uSeed,
      uFlash: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene; uniform vec2 uRes; uniform float uSeed, uFlash;
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
        // wobble the sample point so edges look hand-laid and boil between frames
        vec2 wob = vec2(noise(vec3(vUv * uRes * 0.06, uSeed)), noise(vec3(vUv * uRes * 0.06 + 9.1, uSeed))) - 0.5;
        vec2 uv = vUv + wob * px * 3.0;

        vec3 col = kuwahara(uv);

        // lens fringe toward the edges
        vec2 off = (vUv - 0.5) * px * 6.0;
        col.r = mix(col.r, texture2D(tScene, uv + off).r, 0.35);
        col.b = mix(col.b, texture2D(tScene, uv - off).b, 0.35);

        // slight posterise: discrete but not flat
        col = mix(col, floor(col * 10.0 + 0.5) / 10.0, 0.4);

        float vig = smoothstep(1.05, 0.35, length((vUv - 0.5) * vec2(1.1, 1.0)));
        col *= mix(0.62, 1.0, vig);

        col += (hash(vec3(vUv * uRes, uSeed * 13.0)) - 0.5) * 0.07;
        col = mix(col, vec3(1.0, 0.98, 0.94), uFlash);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const postScene = new THREE.Scene();
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post);
  postQuad.frustumCulled = false;
  postScene.add(postQuad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---------- sizing ----------

  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    const pr = Math.min(devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    rt.setSize(Math.round(w * pr), Math.round(h * pr));
    post.uniforms.uRes.value.set(Math.round(w * pr), Math.round(h * pr));
    backdrop.material.uniforms.uAspect.value = w / h;

    const aspect = w / h;
    view.aspect = aspect;
    // keep the whole camera + strap in frame on narrow screens
    const dist = Math.max(8.2, 2.75 / (Math.tan(THREE.MathUtils.degToRad(view.fov / 2)) * aspect));
    view.position.set(0, 0.35, dist);
    view.lookAt(0, -0.05, 0);
    view.updateProjectionMatrix();
    draw(lastT);
  }

  // ---------- motion ----------

  const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
  let flashT = 0;
  let frameNo = 0;
  let lastT = 0;

  stage.addEventListener("pointermove", (e) => {
    const r = stage.getBoundingClientRect();
    tilt.tx = ((e.clientX - r.left) / r.width - 0.5) * 0.6;
    tilt.ty = ((e.clientY - r.top) / r.height - 0.5) * 0.3;
  });
  stage.addEventListener("pointerleave", () => { tilt.tx = tilt.ty = 0; });

  stage.addEventListener("click", () => {
    if (calm) return;
    flashT = 1;
    const page = document.querySelector(".flash");
    if (page) {
      page.classList.remove("on");
      void page.offsetWidth;
      page.classList.add("on");
    }
  });

  function draw(t) {
    lastT = t;
    tilt.x += (tilt.tx - tilt.x) * 0.35;
    tilt.y += (tilt.ty - tilt.y) * 0.35;

    cam.position.x = 0.35;
    cam.position.y = calm ? 0 : Math.sin(t * 0.9) * 0.08;
    cam.rotation.y = -0.32 + (calm ? 0 : Math.sin(t * 0.45) * 0.38) + tilt.x;
    cam.rotation.x = 0.06 + (calm ? 0 : Math.sin(t * 0.7) * 0.04) + tilt.y;
    cam.rotation.z = calm ? 0 : Math.sin(t * 0.33) * 0.025;

    shared.uSeed.value = frameNo % 3; // three stroke states, cycling = boil
    flashGlow.value = flashT;
    post.uniforms.uFlash.value = flashT * 0.85;
    flashT = Math.max(0, flashT - 0.34);

    renderer.setRenderTarget(rt);
    renderer.render(scene, view);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  }

  let onScreen = true;
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; }).observe(stage);
  new ResizeObserver(resize).observe(stage);
  resize();

  if (calm) return;

  let last = 0;
  const start = performance.now();
  (function loop(now) {
    requestAnimationFrame(loop);
    if (!onScreen || document.hidden || now - last < 1000 / FPS) return;
    last = now;
    frameNo++;
    draw((now - start) / 1000);
  })(start);
}
