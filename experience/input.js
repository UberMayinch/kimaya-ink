// pointer, wheel, pinch and keys -> intents. nothing here knows what the intents do.
//
//   createInput(el, handlers) -> { dispose(), dragging() }
//   handlers: onNudge(dp, source)   wheel / pinch / keys, dp in progress units (signed)
//             onDrag(dx, dy)        pixels since the last move, only after the 6px threshold
//             onDragEnd()
//             onClick(e)            a press that never became a drag (< 6px, < 250ms)
//             onDblClick(e)
//             onKey(e) -> bool      return true when handled (prevents default)
//             onPointer(x, y)       -1..1 across the element, every move

const WHEEL_GAIN = 0.00022; // one mouse notch (100px) ≈ 0.022
const MAX_STEP = 0.03;
const DRAG_PX = 6;
const CLICK_MS = 250;

export function createInput(el, h) {
  const pointers = new Map();
  let down = null;     // { x, y, t, id, dragged }
  let lastClick = 0, lastClickX = 0, lastClickY = 0;
  let pinchDist = 0;
  let dragging = false;

  const inControl = (t) => !!t.closest?.("button, a, input, textarea, select, form, .j-dock, .j-archive");

  function onWheel(e) {
    if (inControl(e.target)) return;
    e.preventDefault();
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    dy = Math.max(-150, Math.min(150, dy));
    const dp = Math.max(-MAX_STEP, Math.min(MAX_STEP, dy * WHEEL_GAIN));
    if (dp) h.onNudge?.(dp, Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY) ? "trackpad" : "wheel");
  }

  function onPointerDown(e) {
    if (inControl(e.target)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      down = null;
      dragging = false;
      return;
    }
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    try { el.setPointerCapture(e.pointerId); } catch {}
  }

  function onPointerMove(e) {
    const r = el.getBoundingClientRect();
    h.onPointer?.(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1, e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) {
        const dp = -Math.log(d / pinchDist) * 0.25;
        if (Math.abs(dp) > 1e-4) h.onNudge?.(Math.max(-MAX_STEP, Math.min(MAX_STEP, dp)), "pinch");
      }
      pinchDist = d;
      return;
    }
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!dragging && Math.hypot(dx, dy) > DRAG_PX) { dragging = true; down.lx = e.clientX; down.ly = e.clientY; }
    if (dragging) {
      h.onDrag?.(e.clientX - down.lx, e.clientY - down.ly, e);
      down.lx = e.clientX;
      down.ly = e.clientY;
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (!down || e.pointerId !== down.id) return;
    const wasDrag = dragging;
    const dt = performance.now() - down.t;
    const dist = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    dragging = false;
    if (wasDrag) { h.onDragEnd?.(); return; }
    if (dist < DRAG_PX && dt < CLICK_MS * 2.4) {
      const now = performance.now();
      const twice = now - lastClick < 300 && Math.hypot(e.clientX - lastClickX, e.clientY - lastClickY) < 24;
      lastClick = twice ? 0 : now;
      lastClickX = e.clientX;
      lastClickY = e.clientY;
      // a second press on a button is a second press; the host's onDblClick only resets when nothing was hit
      const consumed = h.onClick?.(e);
      if (twice && !consumed) h.onDblClick?.(e);
    }
  }

  // a cancelled touch (system gesture, call) is neither a click nor a drag end to act on
  function onPointerCancel(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (down && e.pointerId === down.id) {
      const wasDrag = dragging;
      down = null;
      dragging = false;
      if (wasDrag) h.onDragEnd?.();
    }
  }

  function onKey(e) {
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    // a focused button activates itself; the global Enter / Space only act from the page
    if ((e.key === "Enter" || e.key === " ") && e.target.closest?.("button, a, [tabindex]")) return;
    if (h.onKey?.(e)) { e.preventDefault(); return; }
    let dp = 0;
    if (e.key === "ArrowUp" || e.key === "+" || e.key === "=") dp = 0.02;
    if (e.key === "ArrowDown" || e.key === "-" || e.key === "_") dp = -0.02;
    if (dp) { e.preventDefault(); h.onNudge?.(dp, "keys"); }
  }

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);
  el.addEventListener("dblclick", (e) => { if (!inControl(e.target)) e.preventDefault(); });
  // safari pinch-zooms the page unless told not to
  for (const n of ["gesturestart", "gesturechange", "gestureend"]) el.addEventListener(n, (e) => e.preventDefault());
  addEventListener("keydown", onKey);

  return {
    dragging: () => dragging,
    dispose() {
      el.removeEventListener("wheel", onWheel);
      removeEventListener("keydown", onKey);
    },
  };
}
