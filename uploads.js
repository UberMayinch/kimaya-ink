// uploads: turn an existing photo or short video into what the guestbook api takes.
// every output is redrawn through a canvas, so exif (gps!), filenames and container metadata
// never leave the device. no ui assumptions beyond mountPicker, so it can live on any screen.
//
//   KimayaUploads.prepare(file, { takenOn, start, stamp }) -> Promise<{
//     kind: "image" | "video", photo: Blob (jpeg), clip?: Blob (mp4/webm), takenOn?: "YYYY-MM-DD", width, height }>
//   KimayaUploads.mountPicker(container, onReady, { multiple, preview, label, prepare, onError }) -> { el, input, button, reset, destroy }
//   KimayaUploads.preview(target, result)   fill an element with the prepared still or looping clip
//   KimayaUploads.exifDate(arrayBuffer)     "YYYY-MM-DD" from jpeg exif, or null
//   KimayaUploads.stamp("YYYY-MM-DD")       "'YY MM DD", today if empty

(() => {
  const MAX_EDGE = 1280;
  const MAX_PHOTO = 195 * 1024; // server takes 200KB
  const MAX_CLIP = 790 * 1024; // server takes 800KB
  const MAX_IMAGE_IN = 60 * 1024 * 1024;
  const MAX_VIDEO_IN = 1024 * 1024 * 1024;
  const CLIP_W = 320, CLIP_H = 240, CLIP_FPS = 15, CLIP_SECONDS = 5;
  const CLIP_BPS = 450000; // ~280KB for 5s
  const POSTER_W = 640, POSTER_H = 480;
  const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp)$/i;

  const pad = (n) => String(n).padStart(2, "0");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fail = (msg) => new Error(msg);

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // "2019-05-03" -> "'19 05 03"
  function stamp(day) {
    const [y, m, d] = (day || today()).split("-");
    return `'${y.slice(2)} ${m} ${d}`;
  }

  // same rule as the worker: a real day between 1900 and tomorrow
  function plausible(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const t = Date.parse(`${day}T00:00:00Z`);
    if (isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day) return false;
    return day >= "1900-01-01" && t <= Date.now() + 864e5;
  }

  // ---------- exif date (jpeg only, read-only, tiny) ----------

  const ascii = (v, at, n) => {
    let s = "";
    for (let i = 0; i < n && at + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(at + i));
    return s;
  };

  function exifDate(buf) {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let p = 2;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xff) return null;
      const marker = v.getUint8(p + 1);
      if (marker === 0xff) { p++; continue; } // fill byte
      if (marker === 0xd9 || marker === 0xda) return null; // pixels start, no exif came first
      if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { p += 2; continue; }
      const len = v.getUint16(p + 2);
      if (marker === 0xe1 && ascii(v, p + 4, 6) === "Exif\0\0") {
        return tiffDate(v, p + 10, Math.min(v.byteLength, p + 2 + len));
      }
      p += 2 + len;
    }
    return null;
  }

  function tiffDate(v, t, end) {
    const size = end - t;
    if (size < 8) return null;
    const order = v.getUint16(t);
    const le = order === 0x4949;
    if (!le && order !== 0x4d4d) return null;
    const u16 = (o) => (o + 2 <= size ? v.getUint16(t + o, le) : 0);
    const u32 = (o) => (o + 4 <= size ? v.getUint32(t + o, le) : 0);
    if (u16(2) !== 42) return null;

    const ifd = (off) => {
      const tags = {};
      if (off < 8 || off + 2 > size) return tags;
      const n = u16(off);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > size) break;
        tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), at: e + 8 };
      }
      return tags;
    };
    // ascii values over 4 bytes live at an offset
    const text = (tag) => {
      if (!tag || tag.type !== 2) return "";
      const at = tag.count > 4 ? u32(tag.at) : tag.at;
      if (at + tag.count > size) return "";
      return ascii(v, t + at, Math.min(tag.count, 19));
    };

    const ifd0 = ifd(u32(4));
    const exif = ifd0[0x8769] ? ifd(u32(ifd0[0x8769].at)) : {};
    // DateTimeOriginal, then DateTimeDigitized, then plain DateTime
    for (const s of [text(exif[0x9003]), text(exif[0x9004]), text(ifd0[0x0132])]) {
      const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(s);
      const day = m && `${m[1]}-${m[2]}-${m[3]}`;
      if (day && plausible(day)) return day;
    }
    return null;
  }

  // ---------- canvas helpers ----------

  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  }

  let fontP = null;
  function fontReady() {
    if (!fontP) {
      const load = document.fonts ? document.fonts.load('30px "VT323"').catch(() => {}) : null;
      fontP = Promise.race([load, wait(1500)]);
    }
    return fontP;
  }

  // the digicam stamp, sized like the booth's (30px on a 480px short edge)
  function burnStamp(c, day) {
    const g = c.getContext("2d");
    const size = Math.max(10, Math.round(Math.min(c.width, c.height) / 16));
    g.save();
    g.font = `${size}px "VT323", monospace`;
    g.textAlign = "right";
    g.textBaseline = "bottom";
    g.shadowColor = "rgba(255, 90, 0, .9)";
    g.shadowBlur = size * 0.27;
    g.fillStyle = "#ff8a1f";
    g.fillText(stamp(day), c.width - size * 0.6, c.height - size * 0.4);
    g.restore();
  }

  function cover(c, src, sw, sh) {
    const g = c.getContext("2d");
    const s = Math.max(c.width / sw, c.height / sh);
    const dw = sw * s, dh = sh * s;
    g.drawImage(src, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
  }

  // halve big photos first so the final resize doesn't alias
  function scaled(src, sw, sh, w, h) {
    let cur = src, cw = sw, ch = sh;
    while (cw / 2 >= w && ch / 2 >= h) {
      const c = canvas(Math.round(cw / 2), Math.round(ch / 2));
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(cur, 0, 0, c.width, c.height);
      cur = c; cw = c.width; ch = c.height;
    }
    const out = canvas(w, h);
    const g = out.getContext("2d");
    g.fillStyle = "#fff"; // transparent png -> white, not black
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, w, h);
    return out;
  }

  const toBlob = (c, q) =>
    new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(fail("couldn't encode the photo"))), "image/jpeg", q));

  // always re-encodes, even when small: the original file never goes out
  async function jpegUnder(c, max) {
    for (;;) {
      for (const q of [0.86, 0.78, 0.7, 0.62, 0.54]) {
        const b = await toBlob(c, q);
        if (b.size <= max) return { blob: b, canvas: c };
      }
      if (Math.max(c.width, c.height) < 480) throw fail("photo won't squeeze under 200KB");
      c = scaled(c, c.width, c.height, Math.round(c.width * 0.8), Math.round(c.height * 0.8));
    }
  }

  // ---------- images ----------

  async function decodeImage(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch {}
    // some formats (heic on safari) only decode through <img>, which also honors orientation
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw fail("can't read this photo. try a jpeg or png");
    }
  }

  async function prepareImage(file, opts) {
    if (file.size > MAX_IMAGE_IN) throw fail("that photo is over 60MB");
    let takenOn = opts.takenOn;
    if (takenOn === undefined) takenOn = exifDate(await file.slice(0, 256 * 1024).arrayBuffer()) || undefined;

    const { src, w, h, done } = await decodeImage(file);
    let c;
    try {
      if (!w || !h) throw fail("can't read this photo");
      const s = Math.min(1, MAX_EDGE / Math.max(w, h));
      c = scaled(src, w, h, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    } finally {
      done();
    }
    if (opts.stamp !== false) {
      await fontReady();
      burnStamp(c, takenOn);
    }
    const out = await jpegUnder(c, MAX_PHOTO);
    return { kind: "image", photo: out.blob, takenOn, width: out.canvas.width, height: out.canvas.height };
  }

  // ---------- videos ----------

  function once(el, ok, ms, msg) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => done(rej, fail(msg)), ms);
      const onOk = () => done(res);
      const onErr = () => done(rej, fail(msg));
      function done(f, v) {
        clearTimeout(t);
        el.removeEventListener(ok, onOk);
        el.removeEventListener("error", onErr);
        f(v);
      }
      el.addEventListener(ok, onOk);
      el.addEventListener("error", onErr);
    });
  }

  function clipType() {
    // mp4 first: it plays everywhere, older iphones choke on webm
    for (const t of ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp8", "video/webm"]) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  // plays the source muted in real time and records a stamped 320x240 copy. no audio track.
  async function record(v, start, day, stamped, bps) {
    const c = canvas(CLIP_W, CLIP_H);
    // push frames by hand where we can, so the timer, not paint timing, sets the rate
    let stream = c.captureStream(0);
    let track = stream.getVideoTracks()[0];
    if (!track || !track.requestFrame) {
      stream = c.captureStream(CLIP_FPS);
      track = null;
    }
    const type = clipType();
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: bps } : { videoBitsPerSecond: bps });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = r; });

    const draw = () => {
      cover(c, v, v.videoWidth, v.videoHeight);
      if (stamped) burnStamp(c, day);
      if (track) track.requestFrame();
    };
    draw();
    rec.start(500);
    try {
      await v.play();
    } catch {
      rec.stop();
      stream.getTracks().forEach((t) => t.stop());
      throw fail("can't play this video");
    }
    const t0 = performance.now();
    await new Promise((res) => {
      const timer = setInterval(() => {
        draw();
        const late = performance.now() - t0 > (CLIP_SECONDS + 3) * 1000; // stalled source
        if (v.ended || v.currentTime >= start + CLIP_SECONDS || late) {
          clearInterval(timer);
          res();
        }
      }, 1000 / CLIP_FPS);
    });
    v.pause();
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    return new Blob(chunks, { type: (rec.mimeType || type || "video/webm").split(";")[0] });
  }

  async function seek(v, t) {
    if (Math.abs(v.currentTime - t) < 0.01) return;
    const p = once(v, "seeked", 10000, "can't seek in this video");
    v.currentTime = t;
    await p;
  }

  async function prepareVideo(file, opts) {
    if (file.size > MAX_VIDEO_IN) throw fail("that video is over 1GB");
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      throw fail("this browser can't make clips. try a photo");
    }
    const takenOn = opts.takenOn;
    const stamped = opts.stamp !== false;
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    try {
      const loaded = once(v, "loadeddata", 20000, "can't play this video. try an mp4 or webm");
      v.src = url;
      await loaded;
      if (!v.videoWidth || !v.videoHeight) throw fail("that video has no picture");

      // recorded webms often say Infinity; then just take the first 5s
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const start = Math.min(Math.max(0, Number(opts.start) || 0), Math.max(0, dur - 0.5));
      await seek(v, start);
      if (stamped) await fontReady();

      const poster = canvas(POSTER_W, POSTER_H);
      cover(poster, v, v.videoWidth, v.videoHeight);
      if (stamped) burnStamp(poster, takenOn);
      const photo = (await jpegUnder(poster, MAX_PHOTO)).blob;

      let clip = await record(v, start, takenOn, stamped, CLIP_BPS);
      if (clip.size > MAX_CLIP) {
        await seek(v, start);
        clip = await record(v, start, takenOn, stamped, CLIP_BPS / 3);
      }
      if (!clip.size) throw fail("couldn't record a clip from that video");
      if (clip.size > MAX_CLIP) throw fail("clip came out over 800KB. try a calmer part of the video");
      return { kind: "video", photo, clip, takenOn, width: POSTER_W, height: POSTER_H };
    } finally {
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
    }
  }

  // ---------- entry ----------

  function prepare(file, opts = {}) {
    if (!file || typeof file.size !== "number") return Promise.reject(fail("no file"));
    if (opts.takenOn && !plausible(opts.takenOn)) {
      return Promise.reject(fail("that date doesn't look right"));
    }
    const o = { ...opts, takenOn: opts.takenOn || undefined };
    const type = file.type || "";
    if (type.startsWith("video/") || (!type && VIDEO_EXT.test(file.name || ""))) return prepareVideo(file, o);
    if (type.startsWith("image/") || (!type && IMAGE_EXT.test(file.name || ""))) return prepareImage(file, o);
    return Promise.reject(fail("that's not a photo or a video"));
  }

  // ---------- ui ----------

  const urls = new WeakMap();

  function preview(target, result) {
    (urls.get(target) || []).forEach(URL.revokeObjectURL);
    const made = [];
    const url = (b) => { const u = URL.createObjectURL(b); made.push(u); return u; };
    let el = null;
    if (result && result.clip) {
      el = document.createElement("video");
      el.muted = true;
      el.loop = true;
      el.autoplay = true;
      el.playsInline = true;
      el.poster = url(result.photo);
      el.src = url(result.clip);
    } else if (result && result.photo) {
      el = document.createElement("img");
      el.alt = "";
      el.src = url(result.photo);
    }
    urls.set(target, made);
    target.replaceChildren(...(el ? [el] : []));
    return el;
  }

  function mountPicker(container, onReady, opts = {}) {
    const wrap = document.createElement("div");
    wrap.className = "up-pick";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = opts.big ? "hud-btn big" : "hud-btn";
    btn.textContent = opts.label || "⇪ UPLOAD";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/*";
    input.multiple = !!opts.multiple;
    input.hidden = true;
    const status = document.createElement("p");
    status.className = "up-status";
    status.setAttribute("role", "status");
    const shown = opts.preview === false ? null : document.createElement("div");
    if (shown) shown.className = "up-preview";

    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const files = [...input.files];
      input.value = "";
      if (!files.length) return;
      btn.disabled = true;
      let lastErr = "";
      for (const [i, file] of files.entries()) {
        const n = files.length > 1 ? ` ${i + 1}/${files.length}` : "";
        const video = (file.type || "").startsWith("video/") || VIDEO_EXT.test(file.name || "");
        status.textContent = video ? `MAKING CLIP${n}…` : `READING${n}…`;
        try {
          const result = await prepare(file, opts.prepare);
          if (shown) preview(shown, result);
          await onReady(result, file);
        } catch (err) {
          lastErr = files.length > 1 ? `${file.name}: ${err.message}` : err.message;
          if (opts.onError) opts.onError(err, file);
        }
      }
      status.textContent = lastErr ? `${lastErr}.` : "";
      btn.disabled = false;
    });

    wrap.append(btn, input, status);
    if (shown) wrap.append(shown);
    container.append(wrap);

    const reset = () => {
      status.textContent = "";
      if (shown) preview(shown, null);
    };
    return { el: wrap, input, button: btn, reset, destroy: () => { reset(); wrap.remove(); } };
  }

  window.KimayaUploads = {
    prepare,
    mountPicker,
    preview,
    exifDate,
    stamp,
    limits: { MAX_EDGE, MAX_PHOTO, MAX_CLIP, CLIP_W, CLIP_H, CLIP_FPS, CLIP_SECONDS },
  };
})();
