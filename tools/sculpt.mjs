// sculpts kimaya's figure from smooth signed-distance shapes and meshes it with surface nets.
// run: node tools/sculpt.mjs   ->  assets/figure.bin + assets/figure.json
//
// units: world units, head ~4.4 tall, head centre at the origin, she faces +z (towards us).
// parts are meshed on separate grids so the face and the hand get fine detail:
//   head (+neck, lids, lips)   fine
//   hair                       medium
//   body (shoulders, chest, upper arms)   coarse
//   arm  (forearm + right hand) fine, its own frame so it can swing at the elbow
// the camera itself is built in three.js; the hand is posed around its real bounds.

import { writeFileSync } from "node:fs";

// ---------- vector + sdf helpers ----------

const v = (x, y, z) => [x, y, z];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a + (b - a) * t;

const sphere = (p, c, r) => len(sub(p, c)) - r;
// cheap ellipsoid bound, good enough for smooth blends
function ellipsoid(p, c, r) {
  const q = sub(p, c);
  const k0 = len([q[0] / r[0], q[1] / r[1], q[2] / r[2]]);
  const k1 = len([q[0] / (r[0] * r[0]), q[1] / (r[1] * r[1]), q[2] / (r[2] * r[2])]);
  return k1 === 0 ? -Math.min(...r) : (k0 * (k0 - 1)) / k1;
}
function capsule(p, a, b, r) {
  const pa = sub(p, a), ba = sub(b, a);
  const h = clamp(dot(pa, ba) / dot(ba, ba), 0, 1);
  return len(sub(pa, mul(ba, h))) - r;
}
// capsule whose radius tapers from ra to rb
function cone(p, a, b, ra, rb) {
  const pa = sub(p, a), ba = sub(b, a);
  const h = clamp(dot(pa, ba) / dot(ba, ba), 0, 1);
  return len(sub(pa, mul(ba, h))) - mix(ra, rb, h);
}
// chain of tapered segments through points
function chain(p, pts, radii) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, cone(p, pts[i], pts[i + 1], radii[i], radii[i + 1]));
  return d;
}
function smin(a, b, k) {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return mix(b, a, h) - k * h * (1 - h);
}
const smax = (a, b, k) => -smin(-a, -b, k);

// ---------- pose: camera, hand, arm ----------

// camera size matches a real compact against a ~23cm head: 9.6 x 5.5 x 2 cm
const CAM_SCALE = 0.54;
const CAM = { hx: 1.7 * CAM_SCALE, hy: 1.0 * CAM_SCALE, hz: 0.36 * CAM_SCALE };
// held up in front of her right eye (our left), lens towards us
const CAM_POS = v(-1.15, -0.05, 2.5);

// right hand in camera space: palm against the camera's left end (her right),
// index finger along the top onto the shutter, three fingers curled over the front edge,
// thumb behind. everything placed from the camera's real half-extents.
function handLocal(p) {
  const { hx, hy, hz } = CAM;
  const x0 = -hx; // the end she grips
  const palm = ellipsoid(p, v(x0 - 0.2, -0.12, -0.04), v(0.19, 0.6, 0.5));
  let d = palm;
  // fingers wrap the rounded front-left corner, then lie on the front face
  const fz = hz + 0.12;
  const fingers = [
    { y: 0.2, r: 0.13, tip: x0 + 0.42 },
    { y: -0.08, r: 0.128, tip: x0 + 0.4 },
    { y: -0.34, r: 0.11, tip: x0 + 0.3 },
  ];
  for (const f of fingers) {
    const k = v(x0 - 0.16, f.y + 0.02, 0.38);
    const j = v(x0 + 0.02, f.y, fz + 0.03);
    const t = v(f.tip, f.y - 0.03, fz);
    d = smin(d, chain(p, [k, j, t], [f.r * 1.05, f.r, f.r * 0.82]), 0.09);
  }
  // index: up over the top edge, tip resting on the shutter
  const shutterX = -1.05 * CAM_SCALE;
  d = smin(d, chain(p, [v(x0 - 0.12, 0.38, 0.22), v(x0 - 0.02, hy + 0.14, 0.12), v(shutterX + 0.05, hy + 0.13, 0.0)], [0.135, 0.125, 0.105]), 0.1);
  // thumb on the back
  d = smin(d, chain(p, [v(x0 - 0.18, -0.4, -0.32), v(x0 + 0.05, -0.2, -hz - 0.14), v(x0 + 0.38, -0.08, -hz - 0.12)], [0.17, 0.15, 0.12]), 0.12);
  // wrist
  d = smin(d, cone(p, v(x0 - 0.24, -0.62, -0.08), v(x0 - 0.42, -1.25, -0.25), 0.42, 0.47), 0.2);
  return d;
}
const WRIST_LOCAL = v(-CAM.hx - 0.42, -1.25, -0.25);
const toWorldFromCam = (q) => add(q, CAM_POS);
const toCamFromWorld = (q) => sub(q, CAM_POS);
const WRIST = toWorldFromCam(WRIST_LOCAL);

const SHOULDER_R = v(-3.45, -4.25, -0.4);
// elbow: the point at forearm length from the wrist and upper-arm length from the shoulder,
// pushed out to the side and a little forward
function solveElbow(s, w, lu, lf) {
  let best = null, bestErr = Infinity;
  for (let a = 0; a < 360; a += 1) {
    for (let b = -80; b <= 80; b += 1) {
      const ra = (a * Math.PI) / 180, rb = (b * Math.PI) / 180;
      const dir = v(Math.cos(rb) * Math.cos(ra), Math.sin(rb), Math.cos(rb) * Math.sin(ra));
      const e = add(w, mul(dir, lf));
      const err = Math.abs(len(sub(e, s)) - lu) * 4 + 0.05 * e[1] + 0.02 * e[0] + 0.05 * Math.max(0, -e[2]); // prefer low, out-left, forward
      if (err < bestErr) { bestErr = err; best = e; }
    }
  }
  return best;
}
const ELBOW = solveElbow(SHOULDER_R, WRIST, 4.6, 4.3);

// ---------- the parts ----------

const EYE_L = v(0.6, 0.08, 1.34); // her left (our right)
const EYE_R = v(-0.6, 0.08, 1.34);
const EYE_RADIUS = 0.36;

function headSDF(p) {
  let d = ellipsoid(p, v(0, 0.45, -0.25), v(1.52, 1.86, 1.92));
  d = smin(d, ellipsoid(p, v(0, -0.55, 0.42), v(1.32, 1.62, 1.4)), 0.6);
  d = smin(d, ellipsoid(p, v(0, -1.88, 0.98), v(0.58, 0.44, 0.48)), 0.45);
  for (const s of [-1, 1]) {
    d = smin(d, ellipsoid(p, v(s * 0.82, -0.48, 1.05), v(0.62, 0.55, 0.55)), 0.42); // cheeks
    d = smin(d, ellipsoid(p, v(s * 1.46, -0.15, 0.05), v(0.2, 0.48, 0.32)), 0.15); // ears
  }
  d = smin(d, capsule(p, v(-0.9, 0.46, 1.3), v(0.9, 0.46, 1.3), 0.14), 0.35); // brow
  // nose
  d = smin(d, cone(p, v(0, 0.3, 1.58), v(0, -0.48, 1.95), 0.12, 0.19), 0.24);
  d = smin(d, sphere(p, v(0, -0.53, 1.94), 0.2), 0.14);
  for (const s of [-1, 1]) d = smin(d, sphere(p, v(s * 0.22, -0.62, 1.74), 0.16), 0.12);
  // eye sockets, then lids around the eyeballs
  for (const e of [EYE_L, EYE_R]) {
    d = smax(d, -sphere(p, add(e, v(0, 0, 0.12)), 0.37), 0.08);
    const upper = Math.max(ellipsoid(p, add(e, v(0, 0.04, 0.03)), v(0.44, 0.4, 0.405)), e[1] + 0.165 - p[1]);
    const lower = Math.max(ellipsoid(p, add(e, v(0, -0.04, 0.01)), v(0.42, 0.38, 0.395)), p[1] - (e[1] - 0.13));
    d = smin(d, upper, 0.05);
    d = smin(d, lower, 0.05);
  }
  // full lips with a seam
  d = smin(d, capsule(p, v(-0.3, -0.98, 1.6), v(0.3, -0.98, 1.6), 0.12), 0.15);
  d = smin(d, sphere(p, v(0, -0.92, 1.64), 0.085), 0.08);
  d = smin(d, capsule(p, v(-0.26, -1.22, 1.54), v(0.26, -1.22, 1.54), 0.145), 0.15);
  d = smax(d, -capsule(p, v(-0.34, -1.1, 1.76), v(0.34, -1.1, 1.76), 0.02), 0.022);
  // neck, sinking into the shoulders (the body mesh hides the cut)
  d = smin(d, cone(p, v(0, -1.3, -0.3), v(0, -4.0, -0.45), 0.95, 1.12), 0.55);
  return Math.max(d, -4.0 - p[1]);
}

function hairSDF(p) {
  // a little waviness running down the length
  const w = 0.16 * Math.sin(p[1] * 2.3 + p[2] * 0.8);
  const q = v(p[0] + w * Math.sign(p[0] || 1), p[1], p[2]);
  let d = ellipsoid(q, v(0, 0.58, -0.3), v(1.74, 2.06, 2.06));
  d = smin(d, ellipsoid(q, v(0, 1.25, -0.45), v(1.92, 1.35, 1.9)), 0.5);
  for (const s of [-1, 1]) {
    d = smin(d, chain(q, [v(s * 1.5, 0.7, 0.05), v(s * 1.95, -0.9, -0.15), v(s * 2.15, -2.5, -0.3), v(s * 2.35, -3.9, -0.55)], [0.72, 0.78, 0.7, 0.5]), 0.55);
  }
  d = smin(d, ellipsoid(q, v(0, -1.3, -1.25), v(2.0, 2.9, 1.3)), 0.6);
  // side-swept fringe off the parting
  d = smin(d, chain(q, [v(0.3, 1.8, 1.0), v(-0.55, 1.55, 1.36), v(-1.35, 0.85, 1.25)], [0.24, 0.28, 0.22]), 0.4);
  // keep the face and the front of the neck clear
  d = smax(d, -ellipsoid(p, v(0, -0.45, 1.38), v(1.3, 1.9, 1.35)), 0.25);
  d = smax(d, -capsule(p, v(0, -1.6, 0.6), v(0, -4.5, 0.6), 1.05), 0.3);
  // strand grooves
  d += 0.035 * Math.sin(Math.atan2(p[0], p[2]) * 18 + p[1] * 1.3);
  return d;
}

function bodySDF(p) {
  let d = capsule(p, v(-3.1, -3.95, -0.5), v(3.1, -3.95, -0.5), 1.05);
  d = smin(d, ellipsoid(p, v(0, -6.3, -0.25), v(3.05, 2.9, 1.8)), 0.8);
  for (const s of [-1, 1]) d = smin(d, sphere(p, v(s * 3.4, -4.3, -0.4), 1.0), 0.5);
  d = smin(d, cone(p, v(0, -2.6, -0.42), v(0, -4.2, -0.45), 0.93, 1.08), 0.5); // neck stub, inside the head mesh
  d = smin(d, cone(p, SHOULDER_R, ELBOW, 0.85, 0.62), 0.5); // right upper arm
  d = smin(d, sphere(p, ELBOW, 0.62), 0.2);
  d = smin(d, cone(p, v(3.45, -4.3, -0.4), v(3.9, -10.0, 0.1), 0.92, 0.75), 0.5); // left arm, resting
  return Math.max(d, -10.5 - p[1]);
}

function armSDF(p) {
  let d = cone(p, ELBOW, WRIST, 0.6, 0.44);
  d = smin(d, sphere(p, ELBOW, 0.62), 0.2);
  d = smin(d, handLocal(toCamFromWorld(p)), 0.25);
  return d;
}

// ---------- colour ----------

const C = {
  skin: [178, 120, 94],
  blush: [196, 112, 102],
  lip: [150, 70, 80],
  brow: [40, 28, 30],
  lash: [24, 16, 18],
  hair: [24, 17, 19],
  hairHi: [62, 44, 46],
  top: [88, 128, 196],
  nail: [214, 160, 150],
};
const mixc = (a, b, t) => a.map((x, i) => x + (b[i] - x) * clamp(t, 0, 1));

function headColor(p) {
  let c = C.skin;
  for (const s of [-1, 1]) c = mixc(c, C.blush, 0.6 - len(sub(p, v(s * 0.9, -0.55, 1.35))) * 1.1);
  const lips = Math.min(capsule(p, v(-0.3, -0.98, 1.6), v(0.3, -0.98, 1.6), 0.15), capsule(p, v(-0.26, -1.22, 1.54), v(0.26, -1.22, 1.54), 0.175));
  // whole lip in one colour, deepening into the seam
  if (lips < 0.075 && p[2] > 1.35 && p[1] > -1.42 && p[1] < -0.84) c = mixc(c, C.lip, Math.min(1, (0.075 - lips) / 0.035));
  const seam = Math.abs(p[1] + 1.1);
  if (seam < 0.035 && Math.abs(p[0]) < 0.36 && p[2] > 1.45) c = mixc(c, [92, 40, 46], 1 - seam / 0.035);
  for (const s of [-1, 1]) {
    // brows: a soft arch
    const brow = Math.min(capsule(p, v(s * 0.22, 0.46, 1.52), v(s * 0.64, 0.54, 1.45), 0.08), capsule(p, v(s * 0.64, 0.54, 1.45), v(s * 1.02, 0.45, 1.2), 0.06));
    if (brow < 0.06 && p[2] > 1.0) c = mixc(c, C.brow, 1 - brow / 0.06);
    // lash line along the bottom of the upper lid
    const e = s > 0 ? EYE_L : EYE_R;
    const dy = Math.abs(p[1] - (e[1] + 0.165));
    const dx = Math.abs(p[0] - e[0]);
    // a little flick at the outer corner, like liner
    const flick = Math.max(0, (p[0] - e[0]) * Math.sign(e[0]) - 0.25) * 0.5;
    if (Math.abs(p[1] - (e[1] + 0.165 + flick)) < 0.065 && dx < 0.5 && p[2] > e[2] - 0.05) c = mixc(c, C.lash, 1 - Math.abs(p[1] - (e[1] + 0.165 + flick)) / 0.065);
  }
  return c;
}

function hairColor(p) {
  const streak = 0.5 + 0.5 * Math.sin(Math.atan2(p[0], p[2]) * 9 + p[1] * 0.7);
  return mixc(C.hair, C.hairHi, streak * 0.35);
}

function bodyColor(p) {
  const neckline = -5.2 + 0.25 * Math.cos(p[0] * 0.9);
  const strap = Math.abs(Math.abs(p[0]) - 1.85) < 0.28 && p[1] < -3.4 && p[2] > -1.6;
  const inTop = (p[1] < neckline || strap) && Math.abs(p[0]) < 3.0;
  return inTop ? C.top : C.skin;
}

const armColor = () => C.skin;

// ---------- surface nets ----------

function mesh(sdf, color, min, max, step, relax = 2) {
  const nx = Math.ceil((max[0] - min[0]) / step) + 1;
  const ny = Math.ceil((max[1] - min[1]) / step) + 1;
  const nz = Math.ceil((max[2] - min[2]) / step) + 1;
  const f = new Float32Array(nx * ny * nz);
  const at = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) f[at(i, j, k)] = sdf(v(min[0] + i * step, min[1] + j * step, min[2] + k * step));

  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cat = (i, j, k) => i + (nx - 1) * (j + (ny - 1) * k);
  const pos = [];
  const corners = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const edges = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const vals = corners.map(([a, b, c]) => f[at(i + a, j + b, k + c)]);
        let neg = 0;
        for (const x of vals) if (x < 0) neg++;
        if (neg === 0 || neg === 8) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
          const va = vals[a], vb = vals[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const ca = corners[a], cb = corners[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        cellVert[cat(i, j, k)] = pos.length / 3;
        pos.push(min[0] + (i + sx / n) * step, min[1] + (j + sy / n) * step, min[2] + (k + sz / n) * step);
      }

  const idx = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const f0 = f[at(i, j, k)];
        // x edge
        if ((f0 < 0) !== (f[at(i + 1, j, k)] < 0))
          quad(cellVert[cat(i, j - 1, k - 1)], cellVert[cat(i, j, k - 1)], cellVert[cat(i, j, k)], cellVert[cat(i, j - 1, k)]);
        if ((f0 < 0) !== (f[at(i, j + 1, k)] < 0))
          quad(cellVert[cat(i - 1, j, k - 1)], cellVert[cat(i, j, k - 1)], cellVert[cat(i, j, k)], cellVert[cat(i - 1, j, k)]);
        if ((f0 < 0) !== (f[at(i, j, k + 1)] < 0))
          quad(cellVert[cat(i - 1, j - 1, k)], cellVert[cat(i, j - 1, k)], cellVert[cat(i, j, k)], cellVert[cat(i - 1, j, k)]);
      }

  // pull vertices onto the true surface, take normals from the field gradient
  const nrm = new Float32Array(pos.length);
  const e = step * 0.5;
  const grad = (p) => {
    const g = v(
      sdf(v(p[0] + e, p[1], p[2])) - sdf(v(p[0] - e, p[1], p[2])),
      sdf(v(p[0], p[1] + e, p[2])) - sdf(v(p[0], p[1] - e, p[2])),
      sdf(v(p[0], p[1], p[2] + e)) - sdf(v(p[0], p[1], p[2] - e))
    );
    const l = len(g) || 1;
    return mul(g, 1 / l);
  };
  for (let n = 0; n < pos.length; n += 3) {
    let p = v(pos[n], pos[n + 1], pos[n + 2]);
    for (let r = 0; r < relax; r++) p = sub(p, mul(grad(p), sdf(p)));
    pos[n] = p[0]; pos[n + 1] = p[1]; pos[n + 2] = p[2];
    const g = grad(p);
    nrm[n] = g[0]; nrm[n + 1] = g[1]; nrm[n + 2] = g[2];
  }
  // wind every triangle to face along the gradient
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ab = v(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
    const ac = v(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]);
    const fn = v(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]);
    const gn = v(nrm[a] + nrm[b] + nrm[c], nrm[a + 1] + nrm[b + 1] + nrm[c + 1], nrm[a + 2] + nrm[b + 2] + nrm[c + 2]);
    if (dot(fn, gn) < 0) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  }
  const col = new Uint8Array(pos.length);
  for (let n = 0; n < pos.length; n += 3) {
    const c = color(v(pos[n], pos[n + 1], pos[n + 2]));
    col[n] = c[0]; col[n + 1] = c[1]; col[n + 2] = c[2];
  }
  return { pos: new Float32Array(pos), nrm, col, idx: new Uint32Array(idx) };
}

// ---------- build ----------

const t0 = Date.now();
const parts = {
  head: mesh(headSDF, headColor, v(-1.9, -4.1, -2.4), v(1.9, 2.5, 2.4), 0.03),
  hair: mesh(hairSDF, hairColor, v(-3.0, -4.7, -2.8), v(3.0, 3.1, 2.3), 0.045),
  body: mesh(bodySDF, bodyColor, v(Math.min(-5.0, ELBOW[0] - 1.0), -10.6, -2.6), v(5.0, Math.max(-2.6, ELBOW[1] + 1.0), Math.max(2.6, ELBOW[2] + 1.0)), 0.07),
  arm: mesh(armSDF, armColor, v(Math.min(ELBOW[0], WRIST[0]) - 1.2, Math.min(ELBOW[1], WRIST[1]) - 1.0, Math.min(ELBOW[2], WRIST[2]) - 1.0),
    v(CAM_POS[0] + 0.2, CAM_POS[1] + 1.0, Math.max(CAM_POS[2], ELBOW[2]) + 1.0), 0.022),
};

// pack: per part positions f32, normals i8, colours u8, indices u32
const chunks = [];
const meta = { parts: {}, points: {} };
let offset = 0;
const push = (arr) => {
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const pad = (4 - (buf.length % 4)) % 4;
  chunks.push(buf, Buffer.alloc(pad));
  const at = offset;
  offset += buf.length + pad;
  return at;
};
for (const [name, m] of Object.entries(parts)) {
  const n8 = new Int8Array(m.nrm.length);
  for (let i = 0; i < m.nrm.length; i++) n8[i] = Math.round(m.nrm[i] * 127);
  meta.parts[name] = {
    vertices: m.pos.length / 3,
    indices: m.idx.length,
    pos: push(m.pos),
    nrm: push(n8),
    col: push(m.col),
    idx: push(m.idx),
  };
}
meta.points = { eyeL: EYE_L, eyeR: EYE_R, eyeRadius: EYE_RADIUS, camPos: CAM_POS, camScale: CAM_SCALE, elbow: ELBOW, wrist: WRIST, shoulder: SHOULDER_R };
writeFileSync(new URL("../assets/figure.bin", import.meta.url), Buffer.concat(chunks));
writeFileSync(new URL("../assets/figure.json", import.meta.url), JSON.stringify(meta, null, 1));
for (const [k, p] of Object.entries(meta.parts)) console.log(k, p.vertices, "verts", p.indices / 3, "tris");
console.log("elbow", ELBOW.map((x) => x.toFixed(2)).join(","), "in", ((Date.now() - t0) / 1000).toFixed(1), "s,", (offset / 1e6).toFixed(1), "MB");
