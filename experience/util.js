// small shared helpers for the hero experience

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (x, a, b) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
export const smoother = (x, a, b) => {
  const t = clamp((x - a) / (b - a || 1e-6), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// a bump that rises over [a0,a1] and falls over [b0,b1]
export const win = (x, a0, a1, b0, b1) => smooth(x, a0, a1) * (1 - smooth(x, b0, b1));
export const pad = (n) => String(n).padStart(2, "0");
export const stampOf = (d) => `'${pad(d.getFullYear() % 100)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}`;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

// piecewise-linear table lookup: rows [[p, v...], ...] sorted by p, smootherstep between rows
export function table(rows) {
  const n = rows[0].length - 1;
  return (p, out = new Array(n)) => {
    let i = 0;
    while (i < rows.length - 2 && p > rows[i + 1][0]) i++;
    const a = rows[i], b = rows[i + 1];
    const t = smoother(p, a[0], b[0]);
    for (let k = 0; k < n; k++) out[k] = lerp(a[k + 1], b[k + 1], t);
    return out;
  };
}

export const GLSL_NOISE = /* glsl */ `
  float hash1(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
  }
  float noise3(vec3 x) {
    vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash1(i), hash1(i + vec3(1,0,0)), f.x), mix(hash1(i + vec3(0,1,0)), hash1(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash1(i + vec3(0,0,1)), hash1(i + vec3(1,0,1)), f.x), mix(hash1(i + vec3(0,1,1)), hash1(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  // 2d voronoi: xy = seed of the nearest cell (same units as p), z = distance to the cell edge, w = cell random
  vec4 voro(vec2 p, float cell) {
    vec2 g = p / cell, i = floor(g), f = fract(g);
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
  vec3 hueShift(vec3 c, float a) {
    const vec3 k = vec3(0.57735);
    float cs = cos(a), sn = sin(a);
    return c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
  }
  vec3 rainbow(float t) { return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67))); }
`;
