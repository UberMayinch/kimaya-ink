// the optics: one full-screen pass that composites the portrait and the camera world, draws the two
// tunnels (into her eye, through the lens), and does the lens-like things on top: radial distortion,
// chromatic aberration, light streaks, a cheap bloom, a Y2K grade that leaves skin alone, grain,
// vignette, exposure, the black / white crossings and the booth flash.
//
// scene colour comes in linear (half-float render targets) and leaves display-encoded.

import { GLSL_NOISE } from "./util.js?v=33";

export function createPost(THREE, { tPortrait, tCamera, tPhoto }) {
  const uniforms = {
    tPortrait: { value: tPortrait },
    tCamera: { value: tCamera },
    tPhoto: { value: tPhoto },
    uRes: { value: new THREE.Vector2(1, 1) },
    uAspect: { value: 1 },
    uTime: { value: 0 },
    uSeed: { value: 0 },
    uMix: { value: 0 },        // 0 portrait .. 1 camera world
    uTunnel: { value: 0 },     // 0 scene .. 1 tunnel
    uTunnelMode: { value: 0 }, // 0 her iris, 1 the lens glass
    uZ: { value: 0 },          // tunnel travel
    uFold: { value: 0 },       // kaleidoscope: 0 none .. 1 full fold
    uSegments: { value: 8 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) }, // distortion / tunnel centre, screen uv
    uEyeUv: { value: new THREE.Vector2(0.3425, 0.5907) }, // photo uv (v up)
    uIrisR: { value: 0.0175 },  // iris radius in photo u units
    uDistort: { value: 0 },
    uAberr: { value: 0.08 },
    uVel: { value: 0 },
    uStreak: { value: 0 },
    uBloom: { value: 0.15 },
    uGrain: { value: 0.035 },
    uGrade: { value: 0.6 },
    uIridHue: { value: 0.15 },
    uExposure: { value: 1 },
    uBlack: { value: 0 },
    uWhite: { value: 0 },
    uResolve: { value: 0 },
    uFlash: { value: 0 },
    uCalm: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D tPortrait, tCamera, tPhoto;
      uniform vec2 uRes, uCenter, uEyeUv;
      uniform float uAspect, uTime, uSeed, uMix, uTunnel, uTunnelMode, uZ, uFold, uSegments, uIrisR;
      uniform float uDistort, uAberr, uVel, uStreak, uBloom, uGrain, uGrade, uIridHue, uExposure, uBlack, uWhite, uResolve, uFlash, uCalm;
      varying vec2 vUv;
      ${GLSL_NOISE}
      const float TAU = 6.2831853;

      vec3 scene(vec2 uv) {
        uv = clamp(uv, vec2(0.001), vec2(0.999));
        vec3 a = uMix < 0.999 ? texture2D(tPortrait, uv).rgb : vec3(0.0);
        vec3 b = uMix > 0.001 ? texture2D(tCamera, uv).rgb : vec3(0.0);
        return min(mix(a, b, uMix), vec3(6.0));
      }
      float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

      // the tunnel: log-polar rings around the centre, the angle folded into a kaleidoscope,
      // made of the photograph itself (her iris, or the photograph seen through the glass)
      vec3 tunnel(vec2 uv, float chan) {
        vec2 p = (uv - uCenter) * vec2(uAspect, 1.0);
        float r = max(length(p), 1e-4);
        float a = atan(p.y, p.x + 1e-6);
        float seg = TAU / uSegments;
        float af = abs(mod(a, seg) - seg * 0.5);
        float lr = log(r) * (9.0 - 3.0 * uVel) - uZ + chan;
        float ring = fract(lr / TAU);
        float rad = exp(ring * 0.9) * uIrisR * (uTunnelMode > 0.5 ? 9.0 : 4.0);
        // blend the sample positions, not the angle: the raw angle jumps at the left horizontal
        vec2 q = uEyeUv + mix(vec2(cos(a), sin(a)), vec2(cos(af), sin(af)), uFold) * rad;
        // the lens looks out at the whole photograph; the eye looks into its own iris
        q = uTunnelMode > 0.5 ? q + vec2(sin(lr * 0.5), cos(lr * 0.37)) * 0.03 : q;
        a = af;
        vec3 c = texture2D(tPhoto, clamp(q, 0.0, 1.0)).rgb; // linear: three decodes the sRGB texture on sampling
        // her iris is dark: lift it, and let the glass version glow
        c = pow(c, vec3(0.8)) * (uTunnelMode > 0.5 ? 0.95 : 1.5);
        float bands = 0.6 + 0.4 * sin(lr);
        if (uTunnelMode > 0.5) bands = 0.45 + 0.55 * smoothstep(0.35, 0.65, 0.5 + 0.5 * sin(lr)); // glass elements
        float fibres = 0.75 + 0.25 * sin(a * 24.0 + noise3(vec3(q * 40.0, uTime * 0.2)) * 3.0);
        c *= bands * fibres;
        // thin-film colour on the ring edges
        c += rainbow(ring + a * 0.05 + uTime * 0.03) * 0.45 * smoothstep(0.7, 1.0, ring) * (0.6 + 0.4 * uTunnelMode);
        c += rainbow(a / TAU * 3.0 + lr * 0.08) * 0.12 * smoothstep(0.1, 0.6, r);
        // the core: black for the eye, light for the lens
        float core = smoothstep(0.35, 0.0, r);
        c = mix(c, uTunnelMode > 0.5 ? vec3(1.05, 0.98, 0.9) : vec3(0.0), core * (1.0 - uResolve));
        return c;
      }

      void main() {
        vec2 uv = vUv;
        vec2 px = 1.0 / uRes;
        vec2 d = uv - uCenter;
        vec2 da = d * vec2(uAspect, 1.0);
        float r2 = dot(da, da);

        // radial distortion: the centre magnifies, the rim is sucked in
        vec2 uvD = uCenter + d * (1.0 + uDistort * 1.2 * r2);

        // chromatic aberration, radial, strongest at the rim, racing with zoom velocity
        float ab = (0.012 * uAberr + 0.02 * uVel) * (0.4 + 0.6 * r2) * (1.0 - 0.65 * uCalm);
        vec2 off = d * ab;
        vec3 col;
        col.r = scene(uvD + off).r;
        col.g = scene(uvD).g;
        col.b = scene(uvD - off).b;

        // light streaks + bloom from the bright bits, along the radial direction
        if (uStreak + uBloom > 0.01) {
          vec3 acc = vec3(0.0);
          vec2 dir = normalize(d + 1e-5) * px;
          for (int i = 1; i <= 6; i++) {
            float s = float(i) * 8.0;
            vec3 c1 = scene(uvD + dir * s), c2 = scene(uvD - dir * s);
            acc += max(c1 - 0.8, 0.0) + max(c2 - 0.8, 0.0);
          }
          col += acc * 0.12 * uStreak;
          // bloom: two soft rings scaled to the frame, so small screens don't get a lattice of ghosts
          vec3 bl = vec3(0.0);
          float rad = 0.012 * uRes.y;
          for (int i = 0; i < 12; i++) {
            float an = float(i) * 0.5235988 + 0.26;
            float rr = (i < 6) ? rad * 0.55 : rad;
            vec2 o = vec2(cos(an), sin(an)) * px * rr;
            bl += max(scene(uvD + o) - 0.8, 0.0) * ((i < 6) ? 1.0 : 0.6);
          }
          col += bl * 0.03 * uBloom;
        }

        // the tunnels
        if (uTunnel > 0.001) {
          vec3 tc;
          float ca = 0.04 + 0.06 * uAberr;
          tc.r = tunnel(uv, ca).r;
          tc.g = tunnel(uv, 0.0).g;
          tc.b = tunnel(uv, -ca).b;
          tc = mix(max(tc, 0.0), scene(uv), uResolve);
          col = mix(col, tc, uTunnel);
        }

        // soft shoulder for highlights, then display encode
        col = col / (1.0 + max(col - 0.85, 0.0));
        col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));

        // y2k grade: teal shadows, pink-yellow highlights, a little more colour, iridescent drift.
        // skin (warm, saturated-ish) is mostly left alone.
        {
          float l = luma(col);
          float mx = max(col.r, max(col.g, col.b)), mn = min(col.r, min(col.g, col.b));
          float sat = (mx - mn) / max(mx, 1e-4);
          float hue = sat > 1e-4 ? atan(1.7320508 * (col.g - col.b), 2.0 * col.r - col.g - col.b) : 0.0; // -pi..pi, 0 = red
          float skin = smoothstep(0.08, 0.2, hue) * (1.0 - smoothstep(0.75, 1.0, hue)) * smoothstep(0.12, 0.3, sat);
          float k = uGrade * (1.0 - 0.8 * skin);
          vec3 graded = col;
          graded += vec3(0.02, 0.05, 0.08) * (1.0 - l) * 0.9;            // teal lift in the shadows
          graded *= mix(vec3(1.0), vec3(1.04, 0.985, 0.95), smoothstep(0.5, 1.0, l)); // pink-yellow gain up top
          graded = mix(vec3(luma(graded)), graded, 1.12);               // mid saturation
          float drift = (noise3(vec3(uv * 2.5, uTime * 0.05)) - 0.5) * 0.3 * uIridHue;
          graded = hueShift(graded, drift);
          col = mix(col, graded, k);
        }

        // grain (luma weighted, boils at 12 fps), vignette. a sin hash: the integer-lattice one repeats every ~3 px
        float g = fract(sin(dot(vec3(uv * uRes, uSeed * 13.0 + 1.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453) - 0.5;
        col += g * (uGrain + 0.02 * uVel) * (1.2 - luma(col));
        float vig = smoothstep(1.1, 0.35, length((uv - 0.5) * vec2(1.1, 1.0)));
        col *= mix(0.8, 1.0, vig);

        col *= uExposure;
        col *= 1.0 - uBlack;
        col = mix(col, vec3(1.0, 0.99, 0.97), uWhite);
        col = mix(col, vec3(1.0, 0.98, 0.94), uFlash);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    uniforms,
    material,
    render(renderer) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    },
    resize(w, h) {
      uniforms.uRes.value.set(w, h);
      uniforms.uAspect.value = w / h;
    },
  };
}
