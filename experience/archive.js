// the memory archive: the camera's LCD. a 640x480 canvas drawn like a 2000s cyber-shot screen and
// shown on the camera's back (as an emissive texture) or filling the page (ARCHIVE_OPEN / MEMORY_VIEW).
//
// views while rec.mode === "play":  index (3x3 thumbnails) | item (photo / clip / letter / audio)
// the REC booth (rec.mode !== "play") is the visitor-camera flow, moved here from the old journey.js
// as-is: front camera -> 3,2,1 -> the screen goes white as the flash -> grab -> note -> post.
//
//   createArchive(THREE, { journey, calm, demo, onClose, onHome, onFlash })
//     -> { lcd, items, open(), close(), isOpen(), t, view, sel, select(i), step(dir), onAction(action, hit),
//          drawLCD(), live(), rec, tick(now), srText }

import { loadArchive, letterParagraphs } from "./archive-data.js?v=27";
import { stampOf, wait } from "./util.js?v=27";

const W = 640, H = 480;
const LEFT = 104; // the top-left of the screen sits under her sticker
const HUD = "#9fe8c8", INK = "#e9e6df", DIM = "#8a8780", ORANGE = "#ff8a1f", RED = "#ff4a3d";

export function createArchive(THREE, { journey, calm, demo, visible = () => true, onClose, onHome, onFlash }) {
  const $ = (sel) => journey.querySelector(sel);

  // ---------- the LCD texture ----------

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4; // the screen is often seen at an angle and small
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    emissive: 0xffffff,
    emissiveMap: texture,
    emissiveIntensity: 1.0,
    roughness: 0.12,
    clearcoat: 1,
  });
  const lcd = { canvas, g, texture, material };

  const scan = (() => {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 3;
    const x = c.getContext("2d");
    x.fillStyle = "rgba(0,0,0,.06)";
    x.fillRect(0, 2, 1, 1);
    return g.createPattern(c, "repeat");
  })();

  // ---------- state ----------

  const A = {
    items: [],
    view: "index",   // index | item
    sel: 0,
    page: 0,         // letter page
    open: false,
    t: 0,            // 0 on the camera back .. 1 filling the page
    since: 0,
    lastFlip: 0,
    lastFrame: 0,
    srText: "",
    ready: false,
  };
  let dirty = true;
  const mark = () => { dirty = true; };
  // the black frame between pictures must be followed by a real draw even when frames are scarce
  const flipped = (now) => { A.lastFlip = now; mark(); setTimeout(mark, 80); setTimeout(mark, 160); };

  // ---------- images: thumbnails kept, full images few ----------

  const thumbs = new Map();
  const full = new Map();
  const loading = new Map();
  const failed = new Set();

  function image(item, { thumb = false } = {}) {
    const src = item.src || item.cover;
    if (!src || failed.has(src)) return null;
    if (thumb && thumbs.has(src)) return thumbs.get(src);
    if (full.has(src)) {
      const img = full.get(src);
      if (!thumb) full.delete(src), full.set(src, img); // most recent last
      return img;
    }
    if (!loading.has(src)) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        loading.delete(src);
        const c = document.createElement("canvas");
        c.width = 172;
        c.height = 116;
        cover(c.getContext("2d"), img, img.naturalWidth, img.naturalHeight, 172, 116);
        thumbs.set(src, c);
        full.set(src, img);
        while (full.size > 6) {
          const k = full.keys().next().value;
          full.delete(k);
        }
        mark();
      };
      img.onerror = () => { loading.delete(src); failed.add(src); };
      img.src = src;
      loading.set(src, img);
    }
    return null;
  }

  // ---------- clips and voice notes ----------

  const playVideo = Object.assign(document.createElement("video"), { playsInline: true, muted: true, loop: true, crossOrigin: "anonymous" });
  playVideo.setAttribute("playsinline", "");
  playVideo.setAttribute("muted", "");

  const audio = { el: null, ctx: null, analyser: null, data: null, playing: false, item: null, unlocked: false };
  function audioEl() {
    if (audio.el) return audio.el;
    const el = document.createElement("audio");
    el.preload = "none";
    el.crossOrigin = "anonymous";
    el.addEventListener("ended", () => { audio.playing = false; duck(false); announce(); mark(); });
    el.addEventListener("pause", () => { audio.playing = false; duck(false); announce(); mark(); });
    el.addEventListener("play", () => { audio.playing = true; duck(true); announce(); mark(); });
    audio.el = el;
    window.addEventListener("kimaya:audio-claim", (e) => { if (e.detail !== "voice" && !el.paused) el.pause(); });
    return el;
  }
  function duck(on) { window.KimayaSound?.duck(on); }
  function analyserFor(el) {
    if (audio.analyser) return audio.analyser;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audio.ctx = new AC();
      const src = audio.ctx.createMediaElementSource(el);
      audio.analyser = audio.ctx.createAnalyser();
      audio.analyser.fftSize = 128;
      src.connect(audio.analyser);
      audio.analyser.connect(audio.ctx.destination);
      audio.data = new Uint8Array(audio.analyser.frequencyBinCount);
    } catch { audio.analyser = null; }
    return audio.analyser;
  }
  async function toggleAudio(item) {
    const el = audioEl();
    if (!item?.audio) return;
    if (audio.item !== item) {
      el.src = item.audio;
      audio.item = item;
    }
    if (!el.paused) { el.pause(); return; }
    window.dispatchEvent(new CustomEvent("kimaya:audio-claim", { detail: "voice" }));
    analyserFor(el);
    if (audio.ctx && audio.ctx.state === "suspended") audio.ctx.resume().catch(() => {});
    try { await el.play(); audio.unlocked = true; } catch { audio.playing = false; }
    mark();
  }
  function stopAudio() {
    if (audio.el && !audio.el.paused) audio.el.pause();
  }

  // ---------- open / close: the LCD fills the page ----------

  let fromHistory = false;
  try { if (history.state && history.state.kimayaArchive) history.replaceState(null, ""); } catch {}
  function open() {
    if (A.open) return;
    A.open = true;
    A.since = performance.now();
    if (rec.mode === "play") A.view = "index"; // the collection first, with the slideshow's picture highlighted
    journey.classList.add("focused");
    document.body.classList.add("j-locked");
    try { history.pushState({ kimayaArchive: 1 }, ""); } catch {}
    window.KimayaSound?.cue("charge");
    announce();
    mark();
    // keyboard users land on the overlay's OK button
    setTimeout(() => { if (A.open && !document.activeElement?.closest?.(".j-focusmode")) $(".j-a-ok")?.focus({ preventScroll: true }); }, 50);
  }
  function close() {
    if (!A.open) return;
    A.open = false;
    leaveRec();
    stopAudio();
    stopClip();
    window.KimayaSongs?.pause();
    songChip();
    journey.classList.remove("focused");
    document.body.classList.remove("j-locked");
    if (document.activeElement?.closest?.(".j-focusmode")) setTimeout(() => journey.querySelector(".j-see")?.focus({ preventScroll: true }), 200);
    if (!fromHistory && history.state && history.state.kimayaArchive) {
      fromHistory = true;
      history.back();
    }
    mark();
    onClose?.();
  }
  window.addEventListener("popstate", () => {
    if (fromHistory) { fromHistory = false; return; }
    if (A.open) { fromHistory = true; close(); fromHistory = false; }
  });

  // ---------- navigation ----------

  const current = () => A.items[A.sel] || null;

  function select(i) {
    if (!A.items.length) return;
    const n = A.items.length;
    const next = ((i % n) + n) % n;
    if (next !== A.sel) {
      A.sel = next;
      A.page = 0;
      flipped(performance.now());
      stopAudio();
      window.KimayaSound?.cue("beep");
    }
    songChip();
    announce();
    mark();
  }
  const step = (dir) => select(A.sel + dir);

  function openItem() {
    if (!A.items.length) return;
    A.view = "item";
    A.page = 0;
    flipped(performance.now());
    window.KimayaSound?.cue("beep");
    songChip();
    announce();
    mark();
  }
  function stopClip() {
    if (!playVideo.muted) { playVideo.muted = true; duck(false); }
    if (!playVideo.dataset.src) return;
    playVideo.pause();
    playVideo.removeAttribute("src");
    delete playVideo.dataset.src;
  }
  // the clips loop silently; sound is a choice, and only one thing makes sound at a time
  function toggleClipSound() {
    if (!playVideo.dataset.src) return;
    if (playVideo.muted) {
      window.dispatchEvent(new CustomEvent("kimaya:audio-claim", { detail: "clip" }));
      playVideo.muted = false;
      playVideo.currentTime = 0;
      playVideo.play().catch(() => {});
      duck(true);
    } else {
      playVideo.muted = true;
      duck(false);
    }
    announce();
    mark();
  }
  window.addEventListener("kimaya:audio-claim", (e) => { if (e.detail !== "clip" && !playVideo.muted) { playVideo.muted = true; duck(false); announce(); } });
  function toIndex() {
    stopAudio();
    stopClip();
    A.view = "index";
    songChip();
    announce();
    mark();
  }

  function pageCount(item) {
    return item?.type === "letter" ? layoutLetter(item).pages.length : 1;
  }
  function turnPage(dir) {
    const item = current();
    const n = pageCount(item);
    const p = A.page + dir;
    if (p < 0) return toIndex();
    if (p >= n) return;
    A.page = p;
    flipped(performance.now());
    announce();
    mark();
  }

  // the camera's own buttons (raycast hits in the camera world) and the overlay share this
  function onAction(action, hit) {
    const m = rec.mode;
    if (m !== "play") {
      if (action === "ok" || action === "shutter") {
        if (m === "intro") openCamera();
        else if (m === "live") shutter();
      } else if (action === "play" || action === "menu" || action === "home") leaveRec();
      else if (action === "rec") leaveRec();
      return;
    }
    const item = current();
    switch (action) {
      case "wheel": {
        // left / right halves flip, top / bottom are DISP (no-op) and voice toggle
        let dx = 1;
        if (hit) {
          const local = hit.object.parent.worldToLocal(hit.point.clone());
          dx = local.x - hit.object.position.x;
        }
        step(dx < 0 ? -1 : 1);
        break;
      }
      case "left": step(-1); break;
      case "right": step(1); break;
      case "ok":
        if (A.view === "index") openItem();
        else if (item?.type === "audio") toggleAudio(item);
        else if (item?.type === "clip") toggleClipSound();
        else if (item?.type === "letter") turnPage(1);
        else step(1);
        break;
      case "zoom": {
        let tele = true;
        if (hit) {
          const local = hit.object.parent.worldToLocal(hit.point.clone());
          tele = local.x > hit.object.position.x;
        }
        if (tele) { if (A.view === "index") openItem(); else if (item?.type === "letter") turnPage(1); }
        else { if (A.view === "item") { if (item?.type === "letter" && A.page > 0) turnPage(-1); else toIndex(); } }
        break;
      }
      case "tele": if (A.view === "index") openItem(); else if (item?.type === "letter") turnPage(1); break;
      case "wide": if (A.view === "item") { if (item?.type === "letter" && A.page > 0) turnPage(-1); else toIndex(); } break;
      case "index": toIndex(); break;
      case "play": if (A.view === "item") toIndex(); break;
      case "audio":
        if (item?.type === "audio") toggleAudio(item);
        else if (item?.type === "clip") toggleClipSound();
        break;
      case "menu": if (A.view === "item") toIndex(); else close(); break;
      case "home": close(); onHome?.(); break;
      case "rec":
      case "shutter": stopAudio(); setMode("intro"); break;
      case "lcd": if (!A.open) open(); break;
    }
  }

  // ---------- drawing ----------

  function cover(ctx, src, sw, sh, w, h, mirror = false, x = 0, y = 0) {
    const s = Math.max(w / sw, h / sh);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (mirror) { ctx.translate(x + w, y); ctx.scale(-1, 1); ctx.translate(-x, -y); }
    ctx.drawImage(src, x + (w - sw * s) / 2, y + (h - sh * s) / 2, sw * s, sh * s);
    ctx.restore();
  }

  function text(t, x, y, { align = "left", color = HUD, size = 30, font = "mono", base = "middle", glow = 0 } = {}) {
    g.font = font === "serif" ? `italic ${size}px "Instrument Serif", Georgia, serif` : `${size}px "VT323", monospace`;
    g.textAlign = align;
    g.textBaseline = base;
    g.fillStyle = color;
    if (glow) { g.shadowColor = `rgba(255,90,0,${glow})`; g.shadowBlur = 8; }
    g.fillText(t, x, y);
    g.shadowBlur = 0;
  }

  function chrome({ top = true, bottom = true, blinkOn = true } = {}) {
    g.fillStyle = "rgba(0,0,0,.35)";
    if (top) g.fillRect(0, 0, W, 44);
    if (bottom) g.fillRect(0, H - 54, W, 54);
    // battery
    g.strokeStyle = HUD;
    g.lineWidth = 2;
    g.strokeRect(W - 56, 13, 40, 18);
    g.fillStyle = HUD;
    g.fillRect(W - 14, 18, 4, 8);
    for (let i = 0; i < 3; i++) if (i < 2 || blinkOn) g.fillRect(W - 52 + i * 12, 17, 9, 10);
  }

  function scanlines() {
    if (!scan) return;
    g.fillStyle = scan;
    g.fillRect(0, 0, W, H);
  }

  function typeIcon(type, x, y) {
    g.fillStyle = "rgba(0,0,0,.55)";
    g.fillRect(x - 2, y - 2, 22, 22);
    g.fillStyle = INK;
    if (type === "clip") {
      g.fillRect(x, y, 18, 18);
      g.fillStyle = "#000";
      for (let i = 0; i < 3; i++) { g.fillRect(x + 2, y + 2 + i * 6, 3, 3); g.fillRect(x + 13, y + 2 + i * 6, 3, 3); }
    } else if (type === "letter") {
      g.fillRect(x + 1, y, 16, 18);
      g.fillStyle = "#000";
      for (let i = 0; i < 4; i++) g.fillRect(x + 4, y + 4 + i * 3.5, 10, 1.5);
    } else if (type === "audio") {
      g.fillRect(x + 1, y + 6, 5, 6);
      g.beginPath();
      g.moveTo(x + 6, y + 6); g.lineTo(x + 11, y + 1); g.lineTo(x + 11, y + 17); g.lineTo(x + 6, y + 12);
      g.fill();
      g.strokeStyle = INK; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x + 11, y + 9, 5, -0.9, 0.9); g.stroke();
    }
  }

  function drawEmpty() {
    text("NO IMAGE", W / 2, H / 2 - 14, { align: "center", size: 40 });
    text("the card is waiting for its first memory", W / 2, H / 2 + 22, { align: "center", size: 24, color: DIM });
    text("● leave yours", W / 2, H / 2 + 56, { align: "center", size: 26, color: RED });
  }

  function drawIndex(blinkOn) {
    const items = A.items;
    if (!items.length) { chrome({ blinkOn }); drawEmpty(); return; }
    const page = Math.floor(A.sel / 9), pages = Math.ceil(items.length / 9);
    for (let k = 0; k < 9; k++) {
      const i = page * 9 + k;
      const x = 56 + (k % 3) * 184, y = 54 + Math.floor(k / 3) * 128;
      if (i >= items.length) continue;
      const it = items[i];
      g.fillStyle = "#0a0b0d";
      g.fillRect(x, y, 172, 116);
      const th = (it.src || it.cover) ? image(it, { thumb: true }) : null;
      if (th) g.drawImage(th, x, y);
      else if (it.type === "letter") {
        g.fillStyle = "#1a1917";
        g.fillRect(x, y, 172, 116);
        const lines = letterParagraphs(it.text).join(" ").slice(0, 60);
        text(it.title || lines, x + 10, y + 34, { font: "serif", size: 18, color: "#d9d4c7" });
        text(lines, x + 10, y + 60, { font: "serif", size: 15, color: "#8f8a80" });
      } else if (it.type === "audio") {
        g.fillStyle = "#101316";
        g.fillRect(x, y, 172, 116);
        g.fillStyle = HUD;
        for (let b = 0; b < 12; b++) { const h = 8 + ((b * 37) % 40); g.fillRect(x + 16 + b * 12, y + 58 - h / 2, 6, h); }
      } else {
        text("…", x + 86, y + 58, { align: "center", color: DIM });
      }
      if (it.type !== "photo") typeIcon(it.type, x + 150, y + 94);
      g.lineWidth = i === A.sel ? 3 : 1;
      g.strokeStyle = i === A.sel ? ORANGE : "#2a2a2e";
      g.strokeRect(x - 1.5, y - 1.5, 175, 119);
      if (i === A.sel) { g.lineWidth = 1; g.strokeStyle = "#fff"; g.strokeRect(x + 0.5, y + 0.5, 171, 115); }
    }
    chrome({ blinkOn });
    // folder, card
    text("▤ 100KIMAY", LEFT, 23);
    text(`FINE  [ ${Math.max(0, 999 - items.length)} ]`, W - 70, 23, { align: "right", size: 26 });
    text("◀ ▶ SELECT   OK OPEN", 16, H - 27, { size: 26 });
    text(`${page + 1}/${pages}`, W / 2, H - 27, { align: "center", size: 26, color: INK });
    text(`${A.sel + 1}/${items.length}`, W - 16, H - 27, { align: "right", size: 26, color: INK });
  }

  function drawItem(now, blinkOn) {
    const it = current();
    if (!it) { chrome({ blinkOn }); drawEmpty(); return; }
    const justFlipped = !calm && now - A.lastFlip < 60;
    if (justFlipped) { g.fillStyle = "#000"; g.fillRect(0, 0, W, H); return; }

    if (it.type === "letter") return drawLetter(it, blinkOn);
    if (it.type === "audio") return drawAudio(it, blinkOn);

    // photo / clip
    if (it.type === "clip" && it.clip) {
      if (playVideo.dataset.src !== it.clip) {
        playVideo.dataset.src = it.clip;
        playVideo.src = it.clip;
        playVideo.play().catch(() => {});
      }
    } else if (playVideo.dataset.src) {
      playVideo.pause();
      playVideo.removeAttribute("src");
      delete playVideo.dataset.src;
    }
    const img = image(it);
    if (it.type === "clip" && playVideo.readyState >= 2) cover(g, playVideo, playVideo.videoWidth, playVideo.videoHeight, W, H);
    else if (img) cover(g, img, img.naturalWidth, img.naturalHeight, W, H);
    chrome({ blinkOn });
    text("▶", LEFT, 23);
    if (it.type === "clip") text(playVideo.muted ? "■ VIDEO · ok = sound" : "■ VIDEO ♪", LEFT + 34, 23, { color: RED, size: 26 });
    text(`${it.dsc}   ${A.sel + 1}/${A.items.length}`, W - 70, 23, { align: "right", size: 28 });
    const cap = (it.caption || "") + (it.by ? `  — ${it.by}` : "");
    if (cap.trim()) text(cap.length > 46 ? cap.slice(0, 45) + "…" : cap, 16, H - 27, { font: "serif", size: 28, color: INK });
    if (it.song) {
      const line = `♪ ${it.song.title} — ${it.song.artist}`;
      text(line.length > 40 ? line.slice(0, 39) + "…" : line, LEFT, 64, { size: 26, color: INK });
    }
    if (it.date && !it.stamped) text(stampOf(new Date(it.date + "T12:00:00")), W - 16, H - 74, { align: "right", size: 34, color: ORANGE, glow: 0.9 });
  }

  // letters: word-wrapped in instrument serif, 10 lines a page, layout cached per item
  const layouts = new Map();
  function layoutLetter(it) {
    const key = `${it.id}:${document.fonts?.check?.('italic 26px "Instrument Serif"') ? 1 : 0}`;
    if (layouts.has(key)) return layouts.get(key);
    g.font = 'italic 26px "Instrument Serif", Georgia, serif';
    const maxW = 496, lines = []; // the column starts past the sticker's corner
    for (const para of letterParagraphs(it.text)) {
      for (const raw of para.split("\n")) {
        let line = "";
        for (const word of raw.split(/\s+/)) {
          const test = line ? `${line} ${word}` : word;
          if (g.measureText(test).width > maxW && line) { lines.push(line); line = word; }
          else line = test;
        }
        lines.push(line);
      }
      lines.push("");
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    const pages = [];
    for (let i = 0; i < lines.length; i += 9) pages.push(lines.slice(i, i + 9));
    if (!pages.length) pages.push([""]);
    const out = { lines, pages };
    layouts.set(key, out);
    return out;
  }

  function drawLetter(it, blinkOn) {
    const cov = it.cover ? image(it) : null;
    if (cov) { cover(g, cov, cov.naturalWidth, cov.naturalHeight, W, H); g.fillStyle = "rgba(6,7,8,.78)"; g.fillRect(0, 0, W, H); }
    else { g.fillStyle = "#0b0a09"; g.fillRect(0, 0, W, H); }
    const { pages } = layoutLetter(it);
    const page = Math.min(A.page, pages.length - 1);
    pages[page].forEach((line, i) => text(line, LEFT, 112 + i * 34, { font: "serif", size: 26, color: "#e6e0d2", base: "alphabetic" }));
    chrome({ blinkOn });
    text("✉ LETTER", LEFT, 23);
    text(`PAGE ${page + 1}/${pages.length}`, W - 70, 23, { align: "right", size: 26 });
    const who = [it.title, it.by ? `— ${it.by}` : ""].filter(Boolean).join("  ");
    if (who) text(who.length > 40 ? who.slice(0, 39) + "…" : who, 16, H - 27, { font: "serif", size: 24, color: INK });
    if (it.date) text(stampOf(new Date(it.date + "T12:00:00")), W - 16, H - 27, { align: "right", size: 30, color: ORANGE, glow: 0.9 });
    if (pages.length > 1 && page < pages.length - 1) text("OK ▶", W - 16, H - 74, { align: "right", size: 24, color: DIM });
  }

  function drawAudio(it, blinkOn) {
    const cov = it.cover ? image(it) : null;
    if (cov) { cover(g, cov, cov.naturalWidth, cov.naturalHeight, W, H); g.fillStyle = "rgba(6,7,8,.65)"; g.fillRect(0, 0, W, H); }
    else { g.fillStyle = "#050607"; g.fillRect(0, 0, W, H); }
    const el = audio.el;
    const playing = audio.item === it && el && !el.paused;
    // level bars
    let levels = null;
    if (playing && audio.analyser) { audio.analyser.getByteFrequencyData(audio.data); levels = audio.data; }
    for (let b = 0; b < 48; b++) {
      let h = 4;
      if (levels) {
        const v = levels[Math.min(levels.length - 1, Math.floor(b * levels.length / 48))] / 255;
        h = 4 + v * 150 * (calm ? 0.5 : 1);
      } else if (playing) h = 4 + 20 * Math.abs(Math.sin(performance.now() / 300 + b));
      g.fillStyle = playing ? HUD : "#3a4a44";
      g.fillRect(48 + b * 11.4, 300 - h / 2, 7, h);
    }
    text(playing ? "❚❚" : "▶", W / 2, 200, { align: "center", size: 64, color: INK });
    const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const cur = audio.item === it && el ? el.currentTime || 0 : 0;
    const dur = audio.item === it && el && isFinite(el.duration) ? el.duration : it.duration || 0;
    text(`${fmt(cur)} / ${fmt(dur)}`, W / 2, 350, { align: "center", size: 34, color: INK });
    if (!it.audio) text("no recording attached", W / 2, 390, { align: "center", size: 22, color: DIM });
    chrome({ blinkOn });
    text("♪ VOICE", LEFT, 23);
    text(`${it.dsc}   ${A.sel + 1}/${A.items.length}`, W - 70, 23, { align: "right", size: 28 });
    const cap = [it.title || it.caption, it.by ? `— ${it.by}` : ""].filter(Boolean).join("  ");
    if (cap) text(cap.length > 46 ? cap.slice(0, 45) + "…" : cap, 16, H - 27, { font: "serif", size: 28, color: INK });
    if (it.date) text(stampOf(new Date(it.date + "T12:00:00")), W - 16, H - 74, { align: "right", size: 34, color: ORANGE, glow: 0.9 });
  }

  function drawLCD(now = performance.now()) {
    A.lastFrame = now;
    const blinkOn = calm || Math.floor(now / 700) % 2 === 0;
    g.fillStyle = "#050607";
    g.fillRect(0, 0, W, H);
    if (rec.mode !== "play") drawRec(now, blinkOn);
    else if (A.view === "index") drawIndex(blinkOn);
    else drawItem(now, blinkOn);
    scanlines();
    texture.needsUpdate = true;
    dirty = false;
  }

  // the LCD redraws every frame while something on it moves
  function live() {
    const it = current();
    if (!A.open && !visible()) return false;
    return (
      ["live", "count", "rec"].includes(rec.mode) ||
      (rec.mode === "review" && rec.clip) ||
      (rec.mode === "play" && A.view === "item" && it && (it.type === "clip" || (it.type === "audio" && audio.playing))) ||
      (!calm && A.open && Math.floor(performance.now() / 700) !== Math.floor(A.lastFrame / 700)) || // the battery blink, twice a second
      performance.now() - A.lastFlip < 120 || // the black frame between pictures
      dirty
    );
  }

  // ---------- screen reader mirror ----------

  const sr = $(".j-a-sr");
  function announce() {
    const it = current();
    const n = A.items.length;
    let s = "";
    if (!it) s = "the card is empty";
    else if (A.view === "index") s = `index, ${it.type} ${A.sel + 1} of ${n}, ${it.dsc}${it.caption ? `, ${it.caption}` : ""}${it.by ? ` by ${it.by}` : ""}`;
    else if (it.type === "letter") { const { pages } = layoutLetter(it); s = `letter${it.title ? ` ${it.title}` : ""}${it.by ? ` by ${it.by}` : ""}, page ${A.page + 1} of ${pages.length}. ${pages[Math.min(A.page, pages.length - 1)].join(" ")}`; }
    else if (it.type === "audio") s = `voice note${it.by ? ` by ${it.by}` : ""}${it.caption ? `, ${it.caption}` : ""}, ${audio.playing && audio.item === it ? "playing" : "paused"}`;
    else s = `${it.type === "clip" ? "movie" : "photo"} ${A.sel + 1} of ${n}, ${it.dsc}${it.date ? `, ${it.date}` : ""}${it.caption ? `, ${it.caption}` : ""}${it.by ? ` by ${it.by}` : ""}`;
    A.srText = s;
    if (sr) sr.textContent = s;
    const pageBtns = $(".j-a-pages"), playBtn = $(".j-a-audio");
    if (pageBtns) pageBtns.hidden = !(A.view === "item" && it?.type === "letter" && pageCount(it) > 1);
    if (playBtn) {
      const isClip = it?.type === "clip";
      const playing = isClip ? !playVideo.muted : audio.playing && audio.item === it;
      playBtn.hidden = !(A.view === "item" && (it?.type === "audio" || isClip));
      playBtn.textContent = isClip ? (playing ? "♪ SOUND ON" : "♪ SOUND") : playing ? "❚❚ PAUSE" : "▶ PLAY";
      playBtn.setAttribute("aria-pressed", playing ? "true" : "false");
    }
    const grid = $(".j-a-grid");
    if (grid) grid.setAttribute("aria-pressed", A.view === "index" ? "true" : "false");
  }

  // the current photo's song gets a real play chip in the overlay
  const songSlot = $(".j-song");
  function songChip() {
    if (!songSlot) return;
    const it = current();
    const show = A.open && rec.mode === "play" && A.view === "item" && it?.song && window.KimayaSongs;
    songSlot.replaceChildren(...(show ? [window.KimayaSongs.chip(it.song)] : []));
  }

  // ---------- REC: the visitor-camera flow (unchanged from the old journey.js) ----------
  // play -> intro -> live -> count -> (rec) -> review -> sending -> sent

  const rec = { mode: "play", movie: false, mic: false, stream: null, still: null, photo: null, clip: null, clipURL: "", takenOn: "", count: 0, recStart: 0, gen: 0 };
  const CLIP_SECONDS = 8;
  const video = Object.assign(document.createElement("video"), { playsInline: true, muted: true, autoplay: true });
  const clipVideo = Object.assign(document.createElement("video"), { playsInline: true, muted: true, loop: true });
  const white = $(".j-white");
  const ui = {
    err: $(".j-err"),
    name: $(".j-name"),
    msg: $(".j-msg"),
    left: $(".j-left"),
    photoMode: $(".j-mode-photo"),
    movieMode: $(".j-mode-movie"),
    backToMemories: $(".j-back-memories"),
    upload: $(".j-upload"),
    file: $(".j-file"),
    send: $(".j-send"),
    // the song box: searches apple as you type, so the exact track gets saved
    song: $(".j-songrow") && window.KimayaSongs ? window.KimayaSongs.picker($(".j-songrow")) : null,
  };

  const REC_COPY = {
    intro: "leave her a memory: a photo, an eight second video with sound, or one from your phone. it goes public once kimaya says yes.",
    live: "camera on. press the big button, or space, to take it.",
    count: "counting down",
    rec: "recording eight seconds with sound",
    review: "review your picture, then add your name and a short note.",
    sending: "sending",
    sent: "saved. it'll show up once kimaya says yes.",
  };
  function announceRec(text) {
    A.srText = text;
    if (sr) sr.textContent = text;
  }
  function setMode(mode) {
    rec.mode = mode;
    journey.dataset.lcd = mode;
    songChip();
    if (ui.err) ui.err.textContent = "";
    if (mode === "play") announce();
    else announceRec(REC_COPY[mode] || mode);
    mark();
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
    rec.gen++; // anything still counting down or recording belongs to a booth that is gone
    stopCamera();
    clearShot();
    if (rec.mode !== "play") setMode("play");
  }

  async function openCamera() {
    clearShot();
    try {
      const wantVideo = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } };
      try {
        rec.stream = await navigator.mediaDevices.getUserMedia({ video: wantVideo, audio: true });
      } catch {
        rec.stream = await navigator.mediaDevices.getUserMedia({ video: wantVideo, audio: false }); // no mic: silent videos
      }
      rec.mic = rec.stream.getAudioTracks().length > 0;
      video.srcObject = rec.stream;
      await video.play();
      setMode("live");
    } catch {
      setMode("intro");
      if (ui.err) ui.err.textContent = "camera blocked. allow camera access and try again.";
    }
  }

  // same look as the old booth: mirrored 640x480, hand-done ccd grade, orange stamp
  function grab(source) {
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const x = c.getContext("2d");
    const vw = source.videoWidth, vh = source.videoHeight;
    const s = Math.max(W / vw, H / vh);
    x.save();
    x.translate(W, 0);
    x.scale(-1, 1);
    x.drawImage(source, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
    x.restore();
    const img = x.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], gr = d[i + 1], b = d[i + 2];
      const l = 0.299 * r + 0.587 * gr + 0.114 * b;
      r = l + (r - l) * 1.2; gr = l + (gr - l) * 1.2; b = l + (b - l) * 1.2;
      d[i] = (r - 128) * 1.1 + 134; d[i + 1] = (gr - 128) * 1.1 + 130; d[i + 2] = (b - 128) * 1.1 + 122;
    }
    x.putImageData(img, 0, 0);
    x.font = '30px "VT323", monospace';
    x.textAlign = "right";
    x.textBaseline = "bottom";
    x.shadowColor = "rgba(255, 90, 0, .9)";
    x.shadowBlur = 8;
    x.fillStyle = ORANGE;
    x.fillText(stampOf(new Date()), W - 18, H - 12);
    return c;
  }

  const toJpeg = (c, q = 0.85) =>
    new Promise((resolve) => c.toBlob((b) => (b.size > 190 * 1024 && q > 0.5 ? resolve(toJpeg(c, q - 0.1)) : resolve(b)), "image/jpeg", q));

  async function shutter() {
    if (rec.mode !== "live") return;
    const gen = rec.gen;
    setMode("count");
    for (const n of [3, 2, 1]) {
      rec.count = n;
      announceRec(`${n}`);
      mark();
      await wait(700);
      if (rec.gen !== gen) return;
    }
    rec.count = 0;

    if (rec.movie && window.KimayaClips?.supported()) {
      setMode("rec");
      rec.recStart = performance.now();
      try {
        rec.clip = await window.KimayaClips.record(rec.stream, {
          video,
          seconds: CLIP_SECONDS,
          onstart: () => { rec.still = grab(video); },
        });
        if (rec.gen !== gen) return;
        rec.clipURL = URL.createObjectURL(rec.clip);
        clipVideo.src = rec.clipURL;
        clipVideo.play().catch(() => {});
      } catch (err) {
        if (rec.gen !== gen) return;
        if (ui.err) ui.err.textContent = `${err.message || err}.`;
        setMode("live");
        return;
      }
    } else {
      // the screen is the flash: hold white so it actually lights the face, then grab
      window.KimayaSound?.cue("shutter");
      onFlash?.();
      white?.classList.add("on");
      await wait(220);
      if (rec.gen !== gen) { white?.classList.remove("on"); return; }
      rec.still = grab(video);
      await wait(120);
      white?.classList.remove("on");
    }
    if (rec.gen !== gen) return;
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
      if (ui.err) ui.err.textContent = `${err.message || err}.`;
    }
  }

  async function send(e) {
    e.preventDefault();
    const name = ui.name.value.trim();
    const message = ui.msg.value.trim();
    if (!rec.photo || !name || !message) return;
    const song = ui.song ? ui.song.value() : null;
    ui.send.disabled = true;
    setMode("sending");
    try {
      await window.KimayaGuestbook.post({ name, message, photo: rec.photo, clip: rec.clip, takenOn: rec.takenOn, song });
      ui.name.value = "";
      ui.msg.value = "";
      ui.song?.reset();
      ui.left.textContent = "140";
      clearShot();
      setMode("sent");
    } catch (err) {
      setMode("review");
      if (ui.err) ui.err.textContent = `${err.message || err}.`;
    } finally {
      ui.send.disabled = false;
    }
  }

  function drawRec(now, blinkOn) {
    const m = rec.mode;
    const blink = Math.floor(now / 500) % 2 === 0;

    if ((m === "live" || m === "count" || m === "rec") && video.videoWidth) cover(g, video, video.videoWidth, video.videoHeight, W, H, true);
    if (m === "review" || m === "sending") {
      if (rec.clip && clipVideo.videoWidth) cover(g, clipVideo, clipVideo.videoWidth, clipVideo.videoHeight, W, H);
      else if (rec.still) cover(g, rec.still, rec.still.width, rec.still.height, W, H);
    }

    if (m === "intro" || m === "sent") {
      g.fillStyle = "#050607";
      g.fillRect(0, 0, W, H);
      if (m === "intro") {
        text("● leave her a memory", W / 2, H / 2 - 84, { align: "center", color: RED, size: 40 });
        text("a photo, or an 8 second video with sound,", W / 2, H / 2 - 24, { align: "center", color: INK, size: 28 });
        text("or something already on your phone.", W / 2, H / 2 + 10, { align: "center", color: INK, size: 28 });
        text("it goes public once kimaya says yes.", W / 2, H / 2 + 58, { align: "center", color: DIM, size: 24 });
      } else {
        text("SAVED", W / 2, H / 2 - 20, { align: "center", size: 56 });
        text("it'll show up once kimaya says yes.", W / 2, H / 2 + 30, { align: "center", color: DIM, size: 26 });
      }
      return;
    }

    g.fillStyle = "rgba(0,0,0,.3)";
    g.fillRect(0, 0, W, 44);
    if (m === "rec") {
      const secs = Math.min(CLIP_SECONDS, Math.floor((now - rec.recStart) / 1000));
      text(`${blink ? "●" : " "} REC 00:0${secs} / 00:0${CLIP_SECONDS}${rec.mic ? "  ♪" : ""}`, LEFT, 23, { color: RED });
    } else if (m === "review" || m === "sending") {
      text(m === "sending" ? "SENDING…" : "▶ REVIEW · add your name and a note", LEFT, 23);
    } else if (m === "live") {
      text(rec.movie ? `● VIDEO ${CLIP_SECONDS}s${rec.mic ? " + sound" : ""}` : "■ PHOTO", LEFT, 23);
      text("press the big button", W / 2, H - 30, { align: "center", color: INK, size: 26 });
    } else {
      text(rec.movie ? "● VIDEO" : "■ PHOTO", LEFT, 23);
    }
    text("▮▮▮", W - 16, 23, { align: "right" });
    if (m === "live" || m === "count") {
      g.strokeStyle = m === "count" ? "#6dff9e" : INK;
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
    if (m === "count" && rec.count) text(String(rec.count), W / 2, H / 2, { align: "center", color: "#fff", size: 150 });
    text(stampOf(new Date()), W - 16, H - 30, { align: "right", color: ORANGE, size: 34 });
  }

  // ---------- DOM: the overlay buttons and the REC dock ----------

  const on = (sel, ev, fn) => $(sel)?.addEventListener(ev, (e) => { e.stopPropagation(); fn(e); });
  on(".j-mode-play", "click", () => { leaveRec(); toIndex(); });
  on(".j-mode-rec", "click", () => { if (rec.mode === "play") { stopAudio(); setMode("intro"); } });
  on(".j-open", "click", openCamera);
  on(".j-shutter", "click", shutter);
  on(".j-retake", "click", openCamera);
  on(".j-again", "click", () => setMode("intro"));
  $(".j-form")?.addEventListener("submit", send);
  ui.msg?.addEventListener("input", () => { ui.left.textContent = 140 - ui.msg.value.length; });
  function setMovie(on) {
    rec.movie = on && !!window.KimayaClips?.supported();
    ui.photoMode?.setAttribute("aria-pressed", rec.movie ? "false" : "true");
    ui.movieMode?.setAttribute("aria-pressed", rec.movie ? "true" : "false");
    mark();
  }
  ui.photoMode?.addEventListener("click", (e) => { e.stopPropagation(); setMovie(false); });
  ui.movieMode?.addEventListener("click", (e) => { e.stopPropagation(); setMovie(true); });
  if (ui.movieMode && !window.KimayaClips?.supported()) ui.movieMode.hidden = true;
  ui.backToMemories?.addEventListener("click", (e) => { e.stopPropagation(); leaveRec(); toIndex(); });
  if (ui.upload) {
    ui.upload.hidden = !window.KimayaUploads;
    ui.upload.addEventListener("click", (e) => { e.stopPropagation(); ui.file.click(); });
    ui.file.addEventListener("change", () => { upload(ui.file.files[0]); ui.file.value = ""; });
  }
  on(".j-a-close", "click", () => onAction("menu"));
  on(".j-a-home", "click", () => onAction("home"));
  on(".j-a-grid", "click", () => onAction("index"));
  on(".j-a-prev", "click", () => onAction("left"));
  on(".j-a-next", "click", () => onAction("right"));
  on(".j-a-ok", "click", () => onAction("ok"));
  on(".j-a-page-prev", "click", () => turnPage(-1));
  on(".j-a-page-next", "click", () => turnPage(1));
  on(".j-a-audio", "click", () => onAction("audio"));
  on(".j-exit", "click", () => close());

  // keys while the archive is open (the controller forwards these)
  function onKey(e) {
    if (e.target.closest?.("input, textarea")) return false;
    const m = rec.mode;
    if (e.key === "Escape") { onAction("menu"); return true; }
    if (m === "live" && e.key === " ") { shutter(); return true; }
    if (m !== "play") return false;
    if (e.key === "ArrowLeft") { step(-1); return true; }
    if (e.key === "ArrowRight") { step(1); return true; }
    if (e.key === "ArrowUp" && A.view === "index") { select(A.sel - 3); return true; }
    if (e.key === "ArrowDown" && A.view === "index") { select(A.sel + 3); return true; }
    if (e.key === "Enter") { onAction("ok"); return true; }
    if (e.key === " ") { const it = current(); if (A.view === "item" && it?.type === "audio") { toggleAudio(it); return true; } if (A.view === "item" && it?.type === "clip") { toggleClipSound(); return true; } }
    if (e.key === "PageDown") { turnPage(1); return true; }
    if (e.key === "PageUp") { turnPage(-1); return true; }
    if (e.key === "Backspace") { onAction("menu"); return true; }
    return false;
  }

  // ---------- load ----------

  loadArchive({ demo }).then((items) => {
    A.items = items;
    A.ready = true;
    announce();
    mark();
  });

  return {
    lcd, A, rec,
    get items() { return A.items; },
    open, close, isOpen: () => A.open,
    select, step, openItem, toIndex, turnPage, onAction, onKey,
    drawLCD, live, leaveRec, announce,
    // the LCD slideshows by itself while nobody holds the camera
    autoFlip(now) {
      if (A.open || !visible() || rec.mode !== "play" || !A.items.length || now - A.lastFlip < 3500) return;
      if (A.view !== "item") { A.view = "item"; }
      A.sel = (A.sel + 1) % A.items.length;
      flipped(now);
    },
    tick(dt) {
      const target = A.open ? 1 : 0;
      const moving = Math.abs(A.t - target) > 1e-3;
      A.t = moving ? A.t + (target - A.t) * (calm ? 1 : 1 - Math.exp(-dt * 5)) : target;
      return moving;
    },
  };
}
