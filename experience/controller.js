// the journey's one scalar: p in [0, 1), on a circle. everything else reads it.
//
//   0.00 - 0.30  PORTRAIT          the photograph, zooming towards her face
//   0.30 - 0.52  EYE_APPROACH      the eye is the focus; optics start to bend
//   0.52 - 0.62  EYE_TRANSITION    through the pupil (black at 0.60); glides to the camera on entry
//   0.62 - 0.80  CAMERA_WORLD      the digicam (rest at 0.66); ARCHIVE_OPEN / MEMORY_VIEW branch off here
//   0.80 - 0.92  LENS_APPROACH     into the lens glass
//   0.92 - 1.00  LENS_TRANSITION   the optical tunnel (white at 0.965) that resolves into the photograph at 1 ≡ 0
//
// wheel / pinch / keys nudge a target that p follows; taps fly p somewhere; entering a transition
// range glides p out the far side so a transition always has a defined entry and exit. input cancels
// a glide or a fly at any time, so everything reverses. two transitions never run at once: there is
// only ever one target.

import { clamp, lerp, smoother } from "./util.js?v=37";

export const R = {
  PORTRAIT: 0.30,
  EYE_APPROACH: 0.52,
  EYE_TRANSITION: 0.62,
  CAMERA: 0.80,
  LENS_APPROACH: 0.92,
  SWAP_EYE: 0.60,   // scene swap under black
  SWAP_LENS: 0.965, // scene swap under white
  CAMERA_REST: 0.66,
};

export function stateAt(p, { archiveOpen = false, memory = false, interacting = false } = {}) {
  if (archiveOpen) return memory ? "MEMORY_VIEW" : "ARCHIVE_OPEN";
  if (p < R.PORTRAIT) return interacting ? "PORTRAIT_INTERACTING" : "PORTRAIT_IDLE";
  if (p < R.EYE_APPROACH) return "EYE_APPROACH";
  if (p < R.EYE_TRANSITION) return "EYE_TRANSITION";
  if (p < R.CAMERA) return interacting ? "CAMERA_INTERACTING" : "CAMERA_WORLD";
  if (p < R.LENS_APPROACH) return "LENS_APPROACH";
  return "LENS_TRANSITION";
}

export function createController({ calm = false, pinned = null } = {}) {
  const C = {
    p: 0,
    target: 0,
    vel: 0,       // progress units per second, signed, smoothed
    dir: 1,       // last direction of travel
    fly: null,    // { from, to, t, dur }
    lastInput: 0,
    now: 0,
    wrapped: false,
    detentRadius: 0.012, // a single wheel notch (0.026) must get away from a detent
    detentIdle: 600,
  };
  if (pinned !== null) C.p = C.target = clamp(pinned, 0, 0.999);

  const detents = [0, R.CAMERA_REST];

  function nudge(dp) {
    if (pinned !== null) return;
    const dir = dp < 0 ? -1 : 1;
    C.lastInput = C.now;
    if (C.fly && dir === C.dir) {
      // same direction as a fly or a glide: hurry it along rather than restarting it
      C.fly.t += 120;
      return;
    }
    C.fly = null;
    C.dir = dir;
    // the wrap only goes forward (the glide carries p over 1); backing up at the start stays at the start
    C.target = Math.min(1, Math.max(0, C.target + dp));
  }

  function flyTo(to, dur = 1600) {
    if (pinned !== null) return;
    C.fly = { from: C.p, to, t: 0, dur: calm ? dur * 1.8 : dur };
    C.dir = to >= C.p ? 1 : -1;
    C.lastInput = C.now;
  }

  // the controlled exits of the two transitions
  function glideCheck() {
    if (C.fly || pinned !== null) return;
    const p = C.p;
    const forward = C.dir >= 0;
    if (p >= R.EYE_APPROACH && p < R.EYE_TRANSITION) {
      if (forward) { if (C.target < R.CAMERA_REST) flyTo(R.CAMERA_REST, 1800); }
      else if (C.target > 0.46) flyTo(0.46, 1200);
    } else if (p >= R.LENS_APPROACH && p < 1) {
      if (forward) { if (C.target < 1) flyTo(1.0, 2000); }
      else if (C.target > 0.88) flyTo(0.88, 1200);
    }
  }

  function tick(dt, now) {
    C.now = now;
    const before = C.p;
    if (C.fly) {
      const f = C.fly;
      f.t += dt * 1000;
      const k = smoother(f.t / f.dur, 0, 1);
      C.target = lerp(f.from, f.to, k);
      if (f.t >= f.dur) { C.target = f.to; C.fly = null; }
    } else if (pinned === null && now - C.lastInput > C.detentIdle) {
      // settle onto a detent when idle right next to one
      for (const d of detents) {
        // only a target that is itself resting next to the detent gets pulled onto it
        if (Math.abs(C.p - d) < C.detentRadius && Math.abs(C.target - d) < C.detentRadius * 2 && Math.abs(C.target - d) > 1e-4) C.target += (d - C.target) * (1 - Math.exp(-dt * 6));
      }
    }
    const moving = Math.abs(C.target - C.p) > 1e-5;
    if (moving) C.p += (C.target - C.p) * (calm ? 1 : 1 - Math.exp(-dt * (C.fly ? 12 : 7)));
    // the wrap: past 1 is the start again (p only ever approaches its target, so wrap just short of 1)
    C.wrapped = false;
    if (C.p >= 0.9995) { C.p -= 1; C.target = C.fly ? C.target - 1 : 0; if (C.fly) { C.fly.from -= 1; C.fly.to -= 1; } C.wrapped = true; }
    if (C.p < 0) C.p = 0;
    if (C.target < 0) C.target = 0;
    const dp = C.wrapped ? C.p + 1 - before : C.p - before;
    const v = dt > 0 ? dp / dt : 0;
    C.vel += (v - C.vel) * (1 - Math.exp(-dt / 0.12));
    glideCheck();
    return { moving: moving || !!C.fly, dp };
  }

  // tap on the eye / lens / "next": the next rest point
  function activate() {
    const p = C.p;
    if (p < R.EYE_TRANSITION) flyTo(R.CAMERA_REST, 2200);
    else if (p < R.LENS_APPROACH) flyTo(1.0, 2400);
  }
  // escape / "back": the previous rest point
  function back() {
    const p = C.p;
    if (p > R.CAMERA_REST + 0.02) flyTo(R.CAMERA_REST, 1400);
    else if (p >= R.EYE_APPROACH) flyTo(0, 2000);
    else if (p > 0.001) flyTo(0, 1200);
  }
  function reset() {
    const d = detents.reduce((a, b) => (Math.abs(b - C.p) < Math.abs(a - C.p) ? b : a));
    flyTo(d, 700);
  }

  return {
    C, nudge, flyTo, activate, back, reset, tick,
    get p() { return C.p; },
    get vel() { return C.vel; },
    get flying() { return !!C.fly; },
    locked: () => !!C.fly,
  };
}
