// the camera world: a silver early-2000s compact, lit by her room, floating in the out-of-focus
// colour of the photograph it lives inside. built from primitives, no model file.
//
//   createCameraWorld(THREE, RoundedBoxGeometry, { photo, sticker, lcd })
//     -> { scene, cam, buttons, lensGlass, lcdMesh, flash, lensWorld(), lcdWorld(), backdrop, setHover(obj) }
//
// cam.group is the camera object (units: body 3.4 x 2.0 x 0.72). the lens points +z (towards the
// viewer at the hero pose), the LCD is on the back (-z). buttons carry userData.action:
//   shutter zoom rec play wheel ok menu home lcd lens

export function createCameraWorld(THREE, RoundedBoxGeometry, { photo, sticker, lcd, renderer }) {
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const scene = new THREE.Scene();

  // ---------- light: her room is the environment, so the silver reflects her colours ----------

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envSrc = photo.clone();
  envSrc.mapping = THREE.EquirectangularReflectionMapping;
  envSrc.needsUpdate = true;
  scene.environment = pmrem.fromEquirectangular(envSrc).texture;
  scene.environmentIntensity = 0.85;
  pmrem.dispose();
  envSrc.dispose(); // the PMREM result stands on its own

  const key = new THREE.DirectionalLight(0xffe0c2, 2.0);
  key.position.set(-5, 6, 9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff9466, 2.2);
  rim.position.set(8, 3, -6);
  scene.add(rim);
  const cool = new THREE.DirectionalLight(0x8fd0ff, 0.9);
  cool.position.set(6, -2, 7);
  scene.add(cool);
  const backFill = new THREE.DirectionalLight(0xfff1e0, 1.4); // the screen side is what you meet first
  backFill.position.set(1, 3, -8);
  scene.add(backFill);
  const edgeFill = new THREE.DirectionalLight(0xffe8d8, 0.8);
  edgeFill.position.set(-8, -1, -3);
  scene.add(edgeFill);
  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x9a7a70, 0.9));

  // ---------- materials ----------

  const phys = (p) => new THREE.MeshPhysicalMaterial(p);
  const M = {
    silver: phys({ color: 0xd4d6dc, metalness: 0.88, roughness: 0.34, anisotropy: 0.6, clearcoat: 0.35, clearcoatRoughness: 0.2 }),
    satin: phys({ color: 0xa4a9b4, metalness: 0.9, roughness: 0.42 }),
    bright: phys({ color: 0xe4e6ea, metalness: 0.85, roughness: 0.26 }),
    chrome: phys({ color: 0xf2f2f4, metalness: 1, roughness: 0.1 }),
    worn: phys({ color: 0xb9bcc4, metalness: 1, roughness: 0.55 }),
    black: phys({ color: 0x0c0d10, metalness: 0, roughness: 0.38, clearcoat: 0.5 }),
    coat: phys({ color: 0x0a2a2c, metalness: 0.4, roughness: 0.08, clearcoat: 1, iridescence: 0.9, iridescenceIOR: 1.6, iridescenceThicknessMinimum: 120, iridescenceThicknessMaximum: 520 }),
    flash: phys({ color: 0xe9e7e0, metalness: 0, roughness: 0.18, clearcoat: 1, emissive: 0x000000 }),
    lamp: phys({ color: 0x1a0d06, metalness: 0.2, roughness: 0.05, clearcoat: 1 }),
    led: phys({ color: 0x0a3a1a, emissive: new THREE.Color(0x1aff6a), emissiveIntensity: 0.4 }),
  };

  // ---------- printed labels ----------

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
    return phys({ map: t, transparent: true, metalness: 0, roughness: 0.6, depthWrite: false });
  }

  function marker(text, { w = 512, h = 128, size = 72, color = "#1d1f30" } = {}) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.font = `${size}px "Caveat", "Segoe Print", "Bradley Hand", cursive`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = color;
    g.globalAlpha = 0.82;
    g.fillText(text, w / 2, h / 2 + 2);
    g.fillText(text, w / 2 + 1.5, h / 2 + 3);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return phys({ map: t, transparent: true, metalness: 0, roughness: 0.7, depthWrite: false });
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
    return phys({ map: t, metalness: 0.9, roughness: 0.35 });
  }

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
    return phys({ map: t, metalness: 0.7, roughness: 0.35 });
  }

  // ---------- the lens glass: concentric elements, iridescent coating, a tunnel when you get close ----------

  const glassMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uNear: { value: 0 }, // 0 glass .. 1 full tunnel (set by the controller through LENS_APPROACH)
      uRings: { value: 7 },
    },
    transparent: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      void main() {
        vUv = uv;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uNear, uRings;
      varying vec2 vUv; varying vec3 vN; varying vec3 vW;
      vec3 rainbow(float t) { return 0.5 + 0.5 * cos(6.2831 * (t + vec3(0.0, 0.33, 0.67))); }
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        float a = atan(p.y, p.x);
        vec3 V = normalize(cameraPosition - vW);
        float fr = pow(1.0 - max(dot(normalize(vN), V), 0.0), 3.0);
        // stacked elements: each ring a little deeper and darker, coating colour drifting with angle
        float ring = fract(r * uRings - uTime * 0.05);
        float depthRing = floor(r * uRings) / uRings;
        vec3 base = mix(vec3(0.004, 0.006, 0.012), vec3(0.03, 0.09, 0.11), depthRing * 0.6);
        float edge = smoothstep(0.0, 0.08, ring) * (1.0 - smoothstep(0.85, 1.0, ring));
        vec3 coat = rainbow(depthRing * 0.9 + a * 0.08 + fr * 0.6) * 0.5;
        vec3 col = base + coat * (0.08 + 0.35 * fr) * edge;
        // the pupil: the deepest element, where the tunnel starts
        float pupil = 1.0 - smoothstep(0.26, 0.34, r);
        col = mix(col, vec3(0.002, 0.003, 0.006), pupil * (1.0 - uNear * 0.5));
        // reflection highlights: two soft window shapes
        float hi = smoothstep(0.12, 0.0, length(p - vec2(-0.35, 0.42))) + 0.6 * smoothstep(0.09, 0.0, length(p - vec2(0.3, -0.25)));
        col += vec3(0.9, 0.95, 1.0) * hi * 0.5 * (1.0 - uNear);
        // getting close: the rings light up into a tunnel, kaleidoscopic spokes appear
        float spokes = 0.5 + 0.5 * cos(a * 12.0 + r * 30.0 - uTime * 1.5);
        vec3 tunnel = rainbow(r * 2.0 - uTime * 0.15 + spokes * 0.15) * (0.35 + 0.65 * edge) * smoothstep(1.0, 0.2, r);
        // still glass: the colour lives on the element edges and in the depths, the surface stays dark
        float glassy = edge * 0.7 + 0.3 * smoothstep(0.5, 0.0, r);
        col = mix(col, mix(col, tunnel, glassy), uNear * uNear * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  // ---------- the camera ----------

  const CW = 3.4, CH = 2.0, CD = 0.72, FRONT = CD / 2;
  const disc = (r, h, segs = 64) => new THREE.CylinderGeometry(r, r, h, segs).rotateX(Math.PI / 2);
  const ring = (r0, r1, segs = 64) => new THREE.RingGeometry(r0, r1, segs);

  const group = new THREE.Group();
  const buttons = [];
  const add = (geo, mat, x = 0, y = 0, z = 0, parent = group, action = null) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    if (action) { m.userData.action = action; buttons.push(m); }
    return m;
  };

  // body: a slab with soft edges, a parting seam, worn corners
  add(new RoundedBoxGeometry(CW, CH, CD, 10, 0.32), M.silver);
  [[-1, -1], [1, 1]].forEach(([sx, sy]) => add(new THREE.SphereGeometry(0.09, 10, 8), M.worn, sx * (CW / 2 - 0.2), sy * (CH / 2 - 0.2), FRONT - 0.1));

  // front: lens right of centre, flash top-left, the small lamp between them
  const LX = 0.78, LY = -0.04;
  const lens = new THREE.Group();
  lens.position.set(LX, LY, FRONT);
  group.add(lens);
  add(disc(0.92, 0.05), M.satin, 0, 0, 0.025, lens);
  add(ring(0.66, 0.9), printedRing(), 0, 0, 0.052, lens);
  add(disc(0.66, 0.2), M.silver, 0, 0, 0.1, lens);
  add(disc(0.57, 0.34), M.satin, 0, 0, 0.17, lens);
  add(disc(0.49, 0.48), M.silver, 0, 0, 0.24, lens);
  add(new THREE.TorusGeometry(0.44, 0.045, 16, 64), M.chrome, 0, 0, 0.48, lens);
  add(disc(0.42, 0.02), M.black, 0, 0, 0.48, lens);
  add(disc(0.3, 0.02), M.coat, 0, 0, 0.485, lens);
  const lensGlass = add(new THREE.CircleGeometry(0.34, 64), glassMat, 0, 0, 0.5, lens, "lens");
  const flash = add(new RoundedBoxGeometry(0.8, 0.24, 0.05, 3, 0.06), M.flash, -0.55, 0.64, FRONT);
  add(new RoundedBoxGeometry(0.84, 0.28, 0.03, 3, 0.07), M.chrome, -0.55, 0.64, FRONT - 0.005);
  add(new THREE.TorusGeometry(0.075, 0.018, 12, 32), M.chrome, -0.02, 0.66, FRONT + 0.02);
  add(new THREE.SphereGeometry(0.07, 24, 16), M.lamp, -0.02, 0.66, FRONT + 0.005);
  [-0.06, 0.06].forEach((dx) => add(new THREE.SphereGeometry(0.018, 8, 6), M.black, 0.14 + dx, -0.84, FRONT - 0.005));
  add(new THREE.PlaneGeometry(0.9, 0.25), printed("kimaya", 96, "#40445a", { style: "italic" }), -0.5, -0.32, FRONT + 0.006);
  add(new THREE.PlaneGeometry(1.0, 0.22), marker("into the lens → back to her", { w: 1024, h: 224, size: 88 }), -0.72, 0.12, FRONT + 0.007);
  add(new THREE.PlaneGeometry(0.6, 0.14), marker("↑ take a pic", { w: 512, h: 120, size: 78 }), -1.3, 0.86, FRONT + 0.007);
  add(new THREE.PlaneGeometry(0.62, 0.1), printed("2.0 MEGA PIXELS", 40, "#5a5e70"), 1.25, -0.86, FRONT + 0.006);
  add(new THREE.PlaneGeometry(0.3, 0.16), printed("5x", 90, "#5a5e70"), 1.42, 0.78, FRONT + 0.006);

  // top: shutter with zoom collar, power switch, led
  add(new THREE.TorusGeometry(0.2, 0.05, 12, 40).rotateX(Math.PI / 2), M.satin, -1.05, CH / 2 + 0.03, 0);
  add(new THREE.CylinderGeometry(0.15, 0.16, 0.12, 40), M.chrome, -1.05, CH / 2 + 0.05, 0, group, "shutter");
  add(new RoundedBoxGeometry(0.34, 0.06, 0.16, 2, 0.03), M.satin, -0.3, CH / 2 + 0.02, 0.05);
  add(new THREE.SphereGeometry(0.025, 8, 6), M.led, -0.55, CH / 2 + 0.005, 0.05);

  // back (seen from behind, x grows to our right): framed LCD left, dial / wheel / MENU / HOME right
  const back = new THREE.Group();
  back.position.z = -FRONT;
  back.rotation.y = Math.PI;
  group.add(back);
  add(new RoundedBoxGeometry(2.3, 1.78, 0.04, 3, 0.1), M.bright, -0.52, 0.02, 0.0, back);
  const lcdMesh = add(new THREE.PlaneGeometry(1.96, 1.47), lcd.material, -0.52, 0.06, 0.03, back, "lcd");
  add(new THREE.PlaneGeometry(0.5, 0.12), printed("kimaya", 90, "#3a3e52", { style: "italic" }), 0.2, 0.84, 0.028, back);
  // her marker notes: what the buttons do, written on the frame under the screen and beside the buttons
  add(new THREE.PlaneGeometry(2.14, 0.15), marker("◀ ▶ flip   ok = open   ▶ = memories   dial = rec   menu = back   home = photo", { w: 2560, h: 180, size: 82 }), -0.5, -0.77, 0.028, back);
  add(new RoundedBoxGeometry(0.52, 0.17, 0.06, 2, 0.08), M.chrome, 1.12, 0.74, 0.0, back, "zoom");
  add(new THREE.PlaneGeometry(0.6, 0.1), printed("W        T", 50, "#2d3040"), 1.12, 0.6, 0.01, back);
  add(new THREE.CylinderGeometry(0.31, 0.31, 0.06, 64).rotateX(Math.PI / 2), M.chrome, 1.08, 0.24, 0.02, back, "rec");
  add(new THREE.TorusGeometry(0.31, 0.022, 6, 96), M.satin, 1.08, 0.24, 0.05, back);
  add(new THREE.CircleGeometry(0.27, 48), dialFace(), 1.08, 0.24, 0.054, back, "rec");
  add(disc(0.085, 0.05), M.chrome, 0.8, -0.12, 0.02, back, "play");
  add(new THREE.PlaneGeometry(0.14, 0.1), printed("▶", 110, "#2d3040", { w: 160, h: 120 }), 0.8, 0.0, 0.01, back);
  add(new THREE.TorusGeometry(0.27, 0.06, 12, 48), M.bright, 1.1, -0.38, 0.03, back, "wheel");
  add(disc(0.25, 0.04), M.satin, 1.1, -0.38, 0.02, back, "wheel");
  add(new THREE.PlaneGeometry(0.2, 0.08), printed("DISP", 80, "#2d3040", { w: 256, h: 100 }), 1.1, -0.2, 0.045, back);
  add(disc(0.09, 0.07), M.chrome, 1.1, -0.38, 0.05, back, "ok");
  add(disc(0.085, 0.05), M.chrome, 0.78, -0.82, 0.02, back, "menu");
  add(disc(0.085, 0.05), M.chrome, 1.4, -0.82, 0.02, back, "home");
  add(new THREE.PlaneGeometry(0.42, 0.08), printed("MENU      HOME", 44, "#2d3040"), 1.09, -0.94, 0.01, back);
  // her sticker, slapped on the corner of the screen frame (the LCD keeps that corner empty)
  const stickerMat = phys({ map: sticker, transparent: true, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.15, depthWrite: false });
  const st = add(new THREE.PlaneGeometry(0.54, 0.54), stickerMat, -1.44, 0.66, 0.062, back);
  st.rotation.z = 0.22;
  st.renderOrder = 3;
  add(new THREE.TorusGeometry(0.07, 0.025, 8, 16).rotateY(Math.PI / 2), M.chrome, CW / 2 + 0.02, 0.55, 0);

  scene.add(group);

  // ---------- backdrop: the photograph, far out of focus, as the colour of the space inside her eye ----------

  const blur = (() => {
    const c = document.createElement("canvas");
    c.width = 48;
    c.height = 26;
    const g = c.getContext("2d");
    g.drawImage(photo.image, 0, 0, 48, 26);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
    return t;
  })();
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { tBlur: { value: blur }, uAspect: { value: 1 }, uTime: { value: 0 }, uDim: { value: 0 } },
      depthWrite: false,
      depthTest: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tBlur; uniform float uAspect, uTime, uDim; varying vec2 vUv;
        void main() {
          // slow drift so the bokeh breathes; sample the warm centre of the photo
          vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * 0.55 + vec2(0.42, 0.55) + 0.02 * vec2(sin(uTime * 0.11), cos(uTime * 0.09));
          vec3 c = texture2D(tBlur, p).rgb;
          c = mix(c, vec3(dot(c, vec3(0.3, 0.59, 0.11))), 0.15) * 0.62;
          float vig = smoothstep(1.25, 0.2, length((vUv - 0.5) * vec2(1.2, 1.0)));
          c *= mix(0.25, 1.0, vig);
          c *= 1.0 - uDim;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    })
  );
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1;
  scene.add(backdrop);

  // ---------- hover: the hit object lifts a touch ----------

  let hovered = null;
  const hoverMats = new Map();
  function setHover(obj) {
    if (obj === hovered) return;
    if (hovered) {
      const m = hoverMats.get(hovered);
      if (m) hovered.material = m;
      hoverMats.delete(hovered);
    }
    hovered = obj && obj.userData.action && obj.userData.action !== "lcd" && obj.userData.action !== "lens" ? obj : null;
    if (hovered && hovered.material.isMeshPhysicalMaterial) {
      hoverMats.set(hovered, hovered.material);
      const m = hovered.material.clone();
      m.emissive = new THREE.Color(0xffd9a8);
      m.emissiveIntensity = 0.18;
      hovered.material = m;
    }
  }

  const tmp = new THREE.Vector3();
  return {
    scene,
    group,
    buttons,
    lensGlass,
    lcdMesh,
    flash,
    glassMat,
    backdrop,
    setHover,
    hovered: () => hovered,
    lensWorld: (out = tmp) => lensGlass.getWorldPosition(out),
    lcdWorld: (out = tmp) => lcdMesh.getWorldPosition(out),
    tick(t) {
      glassMat.uniforms.uTime.value = t;
      backdrop.material.uniforms.uTime.value = t;
    },
    size: { CW, CH, CD },
  };
}
