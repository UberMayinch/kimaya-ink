// the photograph as a place: a subdivided plane pushed out by its depth map, textured projectively
// from the start pose so that, from where you begin, it is pixel for pixel the photo. move and it
// turns out to have depth. get close and the picture breaks into facets that split into colour.
//
//   createPortrait(THREE, { photo, depth, size })
//     -> { scene, mesh, uniforms, pose(view, p, aspect, orbit, offset), eyeWorld, eyeHit, start }
//
// world units: the plane is PW x PH (photo 1600x860 -> 18.6 x 10). +x right, +y up, +z towards us.

import { clamp, lerp, smooth, smoother, GLSL_NOISE } from "./util.js?v=32";

export const PHOTO_W = 1600, PHOTO_H = 860;
export const EYE_PX = { x: 548, y: 352, r: 28 };      // the portal eye (her right eye, nearer to us)
export const FACE_PX = { x: 615, y: 390 };

export function createPortrait(THREE, { photo, depth, fov = 35 }) {
  const PW = 18.6, PH = PW * (PHOTO_H / PHOTO_W);
  const toWorld = (px, py) => new THREE.Vector3((px / PHOTO_W - 0.5) * PW, (0.5 - py / PHOTO_H) * PH, 0);
  const eyeUv = new THREE.Vector2(EYE_PX.x / PHOTO_W, 1 - EYE_PX.y / PHOTO_H);
  const eyeWorld = toWorld(EYE_PX.x, EYE_PX.y);
  const faceWorld = toWorld(FACE_PX.x, FACE_PX.y);
  const irisR = (EYE_PX.r / PHOTO_W) * PW; // world units

  // read the depth at the eye so the eye sits at z = 0 and the rig's aim lands on it
  const pivot = (() => {
    const c = document.createElement("canvas");
    c.width = depth.image.width;
    c.height = depth.image.height;
    const g = c.getContext("2d");
    g.drawImage(depth.image, 0, 0);
    const d = g.getImageData(Math.round(eyeUv.x * c.width), Math.round((1 - eyeUv.y) * c.height), 1, 1).data;
    return d[0] / 255;
  })();

  const uniforms = {
    tPhoto: { value: photo },
    tDepth: { value: depth },
    uTexSize: { value: new THREE.Vector2(PHOTO_W, PHOTO_H) },
    uPlane: { value: new THREE.Vector2(PW, PH) },
    uStartEye: { value: new THREE.Vector3(0, 0, 30) },
    uPivot: { value: pivot },
    uAmount: { value: 1.1 },
    uTime: { value: 0 },
    uFacet: { value: 1 },
    uSplit: { value: 0 },
    uFold: { value: 0 },
    uFoldN: { value: 6 },
    uLiquid: { value: 0 },
    uEyeUv: { value: eyeUv },
    uIrisUv: { value: EYE_PX.r / PHOTO_W },
    uCalm: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      uniform sampler2D tDepth;
      uniform vec2 uPlane;
      uniform vec3 uStartEye;
      uniform float uPivot, uAmount;
      varying vec2 vUv;    // projective, from the start pose: at the start pose this is the flat photo
      varying vec2 vUvP;   // plane uv
      varying float vLayer, vDepth;
      void main() {
        vUvP = uv;
        vec3 dl = texture2D(tDepth, uv).rgb;
        float layer = dl.g;
        // layers push a little differently: the phone in the foreground pops, the wall stays back
        float mul = layer < 0.1 ? 0.85 : layer < 0.3 ? 1.0 : layer < 0.5 ? 1.0 : layer < 0.7 ? 1.0 : 1.15;
        float z = (dl.r - uPivot) * uAmount * mul;
        vLayer = layer;
        vDepth = dl.r;
        vec3 p = vec3(position.xy, z);
        // ray from the start eye through this displaced point, back to the z=0 plane
        vec3 d = p - uStartEye;
        float t = -uStartEye.z / min(d.z, -1e-4);
        vec3 hit = uStartEye + d * t;
        vUv = hit.xy / uPlane + 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tPhoto;
      uniform vec2 uTexSize, uEyeUv;
      uniform float uTime, uFacet, uSplit, uFold, uFoldN, uLiquid, uIrisUv, uCalm;
      varying vec2 vUv, vUvP;
      varying float vLayer, vDepth;
      ${GLSL_NOISE}
      const float TAU = 6.2831853;

      vec3 photo(vec2 uv) { return texture2D(tPhoto, clamp(uv, 0.0, 1.0)).rgb; }

      void main() {
        vec2 uv = vUv;
        // liquid colour around the eye: the iris swims, the skin doesn't
        float eyeDist = distance((uv - uEyeUv) * vec2(1.0, uTexSize.y / uTexSize.x), vec2(0.0));
        float near = 1.0 - smoothstep(2.0 * uIrisUv, 5.0 * uIrisUv, eyeDist);
        if (uLiquid > 0.001) {
          float n = noise3(vec3(uv * 180.0, uTime * (0.4 - 0.3 * uCalm)));
          uv += (vec2(n, noise3(vec3(uv * 180.0 + 3.1, uTime * 0.3))) - 0.5) * 0.004 * uLiquid * near;
        }
        // kaleidoscope fold about the eye, arriving as you get very close
        vec2 tuv = uv * uTexSize;
        if (uFold > 0.001) {
          vec2 e = uEyeUv * uTexSize;
          vec2 p = tuv - e;
          float a = atan(p.y, p.x), seg = TAU / uFoldN;
          float af = abs(mod(a, seg) - seg * 0.5);
          vec2 folded = e + length(p) * vec2(cos(af), sin(af));
          tuv = mix(tuv, folded, uFold);
          uv = tuv / uTexSize;
        }

        // magnification: screen pixels per photo texel
        float mag = 1.0 / max(max(length(dFdx(vUv * uTexSize)), length(dFdy(vUv * uTexSize))), 1e-5);
        vec3 col = photo(uv);

        if (mag < 2.5) {
          // far: a touch of unsharp mask so the picture reads as detailed
          vec2 t = 1.2 / uTexSize;
          vec3 blur = (photo(uv + vec2(t.x, 0.0)) + photo(uv - vec2(t.x, 0.0)) + photo(uv + vec2(0.0, t.y)) + photo(uv - vec2(0.0, t.y))) * 0.25;
          col += (col - blur) * 0.35 * (1.0 - mag / 2.5);
        }

        // close: the picture breaks into cells, anchored to the photo, splitting in two each octave
        float k = smoothstep(2.5, 9.0, mag) * uFacet;
        if (k > 0.001) {
          float lg = log2(max(mag / 2.5, 1.0));
          float cell0 = 16.0 / exp2(floor(lg));
          float w = fract(lg);
          vec3 fc = vec3(0.0);
          for (int o = 0; o < 2; o++) {
            float cell = o == 0 ? cell0 : cell0 * 0.5;
            vec4 v = voro(tuv, cell);
            vec2 seed = v.xy / uTexSize;
            vec2 h = hash2(v.xy * 0.37) - 0.5;
            vec2 dir = h * cell * 0.5 * uSplit / uTexSize;
            vec3 c;
            c.r = photo(seed + dir).r;
            c.g = photo(seed).g;
            c.b = photo(seed - dir).b;
            // each shard is a little tilted pane: a lit side and a shadow side, a thin dark lead line
            vec2 g = (tuv - v.xy) / cell;
            float shade = 0.88 + 0.24 * clamp(dot(g, normalize(h + 1e-4)), -1.0, 1.0);
            float lead = smoothstep(0.0, 0.09, v.z / cell);
            c *= mix(0.45, 1.0, lead) * shade * (0.92 + 0.16 * v.w);
            // a thin-film tint that gets stronger the closer you are
            c = mix(c, c * rainbow(v.w + lg * 0.1) * 1.6, 0.12 * uSplit + 0.06);
            fc += c * (o == 0 ? 1.0 - w : w);
          }
          col = mix(col, fc, k);
        }

        // a faint iridescent sheen that lives in the highlights of the glossy wallpaper, not her face
        float sheen = smoothstep(0.55, 0.95, dot(col, vec3(0.33))) * (1.0 - step(0.3, vLayer) * step(vLayer, 0.5)) * 0.08;
        col = mix(col, hueShift(col, (noise3(vec3(uv * 6.0, uTime * 0.07)) - 0.5) * 1.2), sheen);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const SEG_X = 288, SEG_Y = Math.round(288 * PH / PW);
  const geometry = new THREE.PlaneGeometry(PW, PH, SEG_X, SEG_Y);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);

  // behind the plane: the same photograph, blurred and dimmed, so no tilt or parallax ever shows black
  const blurTex = (() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 34;
    c.getContext("2d").drawImage(photo.image, 0, 0, 64, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  })();
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { tBlur: { value: blurTex }, uAspect: { value: 1 }, uAim: { value: new THREE.Vector2(0.5, 0.5) } },
      depthWrite: false,
      depthTest: false,
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tBlur; uniform float uAspect; uniform vec2 uAim; varying vec2 vUv;
        void main() {
          vec2 p = uAim + (vUv - 0.5) * vec2(uAspect, 1.0) * 0.55;
          vec3 c = texture2D(tBlur, clamp(p, 0.0, 1.0)).rgb * 0.7;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    })
  );
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1;
  scene.add(backdrop);

  // an invisible disc on the eye for taps
  const eyeHit = new THREE.Mesh(new THREE.CircleGeometry(irisR * 2.2, 24), new THREE.MeshBasicMaterial({ visible: false }));
  eyeHit.position.copy(eyeWorld).setZ(0.02);
  eyeHit.userData.action = "eye";
  scene.add(eyeHit);

  // ---------- the rig ----------

  const T = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  // distance at which the plane covers the viewport (with overscan so displaced edges never show)
  const cover = (aspect) => Math.min(PH / 2 / T, PW / 2 / (T * aspect)) * 0.9;

  // the start composition: the whole photo, or on a tall screen the slice that holds her face
  const start = { aim: new THREE.Vector3(), dist: 1 };
  function startPose(aspect) {
    const dist = cover(aspect);
    const halfW = dist * T * aspect, halfH = dist * T;
    const ax = clamp(faceWorld.x * 0.6, -(PW / 2 - halfW), PW / 2 - halfW);
    const ay = clamp(faceWorld.y * 0.3, -(PH / 2 - halfH), PH / 2 - halfH);
    start.aim.set(ax, ay, 0);
    start.dist = dist;
    return start;
  }

  const tmpAim = new THREE.Vector3(), tmpDir = new THREE.Vector3(), tmpPos = new THREE.Vector3();
  const look = new THREE.Vector3();

  // p: progress. orbit: {yaw, pitch} radians. offset: {x, y} units of pointer parallax.
  // returns the fov it set. the portrait is visible for p < 0.62 and again for p > 0.92 (start pose).
  function pose(view, p, aspect, orbit, offset) {
    const s = startPose(aspect);
    let aim, dist, f = fov;
    if (p >= 0.9) {
      aim = tmpAim.copy(s.aim);
      dist = s.dist;
    } else {
      // 0 .. 0.30: dolly in, drift the aim towards her face
      const z1 = smoother(p, 0, 0.3);
      aim = tmpAim.copy(s.aim).lerp(faceWorld, z1);
      dist = Math.exp(lerp(Math.log(s.dist), Math.log(s.dist * 0.5), z1));
      // 0.30 .. 0.52: aim to the eye, wider and closer
      const z2 = smoother(p, 0.3, 0.42);
      aim.lerp(eyeWorld, z2);
      const z3 = smoother(p, 0.3, 0.52);
      dist = Math.exp(lerp(Math.log(dist), Math.log(1.2), z3));
      f = lerp(fov, 45, z3);
      // 0.52 .. 0.62: through the pupil
      const z4 = smoother(p, 0.52, 0.6);
      dist = Math.exp(lerp(Math.log(dist), Math.log(0.05), z4));
    }
    // keep the frame inside the photo while the eye is still far from the centre
    const Tf = Math.tan(THREE.MathUtils.degToRad(f / 2));
    const halfW = dist * Tf * aspect, halfH = dist * Tf;
    const edge = smooth(p, 0.0, 0.3); // the clamp relaxes as we close in (the eye is never near an edge)
    aim.x = clamp(aim.x, -(PW / 2 - halfW) * (1 - edge) - 99 * edge, (PW / 2 - halfW) * (1 - edge) + 99 * edge);
    aim.y = clamp(aim.y, -(PH / 2 - halfH) * (1 - edge) - 99 * edge, (PH / 2 - halfH) * (1 - edge) + 99 * edge);

    const yaw = orbit ? orbit.yaw : 0, pitch = orbit ? orbit.pitch : 0;
    tmpDir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    tmpPos.copy(aim).addScaledVector(tmpDir, dist);
    if (offset) { tmpPos.x += offset.x; tmpPos.y += offset.y; }
    view.position.copy(tmpPos);
    view.lookAt(look.copy(aim));
    if (view.fov !== f) { view.fov = f; view.updateProjectionMatrix(); }
    return f;
  }

  // where the start eye is for the projective mapping: the start pose's position
  function setStart(aspect) {
    const s = startPose(aspect);
    uniforms.uStartEye.value.set(s.aim.x, s.aim.y, s.dist);
    backdrop.material.uniforms.uAspect.value = aspect;
    backdrop.material.uniforms.uAim.value.set(s.aim.x / PW + 0.5, s.aim.y / PH + 0.5);
  }

  const proj = new THREE.Vector3();
  function eyeScreen(view, out) {
    proj.copy(eyeWorld).project(view);
    out.set(proj.x * 0.5 + 0.5, proj.y * 0.5 + 0.5);
    return out;
  }

  return {
    scene, mesh, uniforms, material, eyeHit, eyeWorld, faceWorld, eyeUv, irisR,
    pose, setStart, eyeScreen, startPose,
    tick(t) { uniforms.uTime.value = t; },
  };
}
