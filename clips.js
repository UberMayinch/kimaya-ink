// movie mode: tiny 320x240 digicam clips, recorded in the browser.
//
//   KimayaClips.supported()                 -> bool
//   KimayaClips.type()                      -> mime type record() will use, or ""
//   KimayaClips.record(stream, opts)        -> Promise<Blob>  (video/mp4 or video/webm, with sound if the stream has a mic track)
//     opts: seconds=8 width=320 height=240 fps=15 bitrate=280000 audioBitrate=48000 maxBytes=700KB
//           video    an already-playing <video> showing the stream (reused, safer on iOS)
//           mirror   default true, flip like a selfie preview
//           signal   AbortSignal, stops early and rejects
//           onstart(canvas)  called once the first frame is drawn, right before recording
//   KimayaClips.player(src, { poster, song })  -> <video> for prints, muted + looping; a tap gives it sound,
//     and the song (object, or a function returning one) plays quietly underneath. v.quiet() mutes it again.

(() => {
  // types that carry sound first; the bare ones still take an audio track where the browser allows
  const TYPES = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4;codecs=avc1", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];
  const MAX_BYTES = 700 * 1024;

  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (d) => `'${pad(d.getFullYear() % 100)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function type() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  function supported() {
    const c = typeof document !== "undefined" && document.createElement("canvas");
    return !!(c && c.captureStream && type());
  }

  // a <video> we can draw from, with real dimensions
  async function source(stream, video) {
    const v = video || document.createElement("video");
    if (!video) {
      v.muted = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.srcObject = stream;
    }
    if (!v.videoWidth) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("camera never started")), 5000);
        v.addEventListener("loadedmetadata", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    if (v.paused) await v.play().catch(() => {});
    return v;
  }

  // cheap CCD grade by hand: a bit more saturation + contrast, warm lift (same as the booth still)
  function grade(g, W, H) {
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], gr = d[i + 1], b = d[i + 2];
      const l = 0.299 * r + 0.587 * gr + 0.114 * b;
      r = l + (r - l) * 1.2;  gr = l + (gr - l) * 1.2;  b = l + (b - l) * 1.2;
      d[i] = (r - 128) * 1.1 + 134;
      d[i + 1] = (gr - 128) * 1.1 + 130;
      d[i + 2] = (b - 128) * 1.1 + 122;
    }
    g.putImageData(img, 0, 0);
  }

  function frame(g, v, o, t, date) {
    const { width: W, height: H } = o;

    // cover-crop, mirrored like the preview
    const vw = v.videoWidth, vh = v.videoHeight;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    g.save();
    if (o.mirror) {
      g.translate(W, 0);
      g.scale(-1, 1);
    }
    g.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
    g.restore();
    grade(g, W, H);

    const px = Math.round(H / 15); // 16px at 240
    g.font = `${px}px "VT323", monospace`;
    g.textBaseline = "alphabetic";

    // blinking red rec with the seconds, half a second on, half off
    if (Math.floor(t * 2) % 2 === 0) {
      g.fillStyle = "#ff2a2a";
      g.shadowColor = "rgba(255, 0, 0, .8)";
      g.shadowBlur = 4;
      g.beginPath();
      g.arc(px * 0.9, px * 1.05, px * 0.32, 0, Math.PI * 2);
      g.fill();
      g.textAlign = "left";
      g.fillText(`REC ${pad(Math.floor(t))}`, px * 1.5, px * 1.4);
    }

    // orange date stamp
    g.textAlign = "right";
    g.shadowColor = "rgba(255, 90, 0, .9)";
    g.shadowBlur = 4;
    g.fillStyle = "#ff8a1f";
    g.fillText(stamp(date), W - px * 0.6, H - px * 0.5);
    g.shadowBlur = 0;
  }

  async function record(stream, opts = {}) {
    const o = {
      seconds: 8, width: 320, height: 240, fps: 15,
      bitrate: 280000, audioBitrate: 48000, maxBytes: MAX_BYTES, mirror: true,
      ...opts,
    };
    const mime = type();
    if (!mime) throw new Error("movie mode not supported here");
    if (o.signal && o.signal.aborted) throw new Error("stopped");

    const v = await source(stream, o.video);
    if (document.fonts && document.fonts.load) {
      await Promise.race([document.fonts.load('16px "VT323"').catch(() => {}), wait(1500)]);
    }

    const c = document.createElement("canvas");
    c.width = o.width;
    c.height = o.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    const date = new Date();
    frame(g, v, o, 0, date);
    if (o.onstart) o.onstart(c);

    const out = c.captureStream();
    // the mic rides along with the drawn frames
    const mic = o.audio === false ? null : stream.getAudioTracks()[0];
    if (mic) out.addTrack(mic);
    const rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: o.bitrate, audioBitsPerSecond: o.audioBitrate });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    let aborted = false;
    const done = new Promise((resolve, reject) => {
      rec.onstop = resolve;
      rec.onerror = (e) => reject(e.error || new Error("recording failed"));
    });

    const t0 = performance.now();
    rec.start(500);
    const tick = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      if (t >= o.seconds) return finish();
      frame(g, v, o, t, date);
    }, 1000 / o.fps);

    function finish() {
      clearInterval(tick);
      if (rec.state !== "inactive") rec.stop();
    }
    const onAbort = () => { aborted = true; finish(); };
    if (o.signal) o.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await done;
    } finally {
      clearInterval(tick);
      if (o.signal) o.signal.removeEventListener("abort", onAbort);
      out.getVideoTracks().forEach((t) => t.stop()); // only our canvas track, never the camera or the mic
      if (!o.video) v.srcObject = null;
    }
    if (aborted) throw new Error("stopped");

    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    if (!blob.size) throw new Error("recording came out empty");
    if (blob.size > o.maxBytes) throw new Error("clip too big");
    return blob;
  }

  function player(src, opts = {}) {
    const v = document.createElement("video");
    v.className = "clip";
    // set both attribute and property: ios only autoplays when muted is really on
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    for (const a of ["muted", "loop", "autoplay", "playsinline"]) v.setAttribute(a, "");
    v.preload = "metadata";
    v.disablePictureInPicture = true;
    if (opts.poster) v.poster = opts.poster;
    if (src) v.src = src;
    // a tap turns the sound on (and off again); anything else that starts playing sound mutes it.
    // with a song on the post, the song plays quietly under the clip's own sound.
    const song = () => (typeof opts.song === "function" ? opts.song() : opts.song) || null;
    const songOn = (on) => { const s = song(); if (window.KimayaSongs?.accompany && (s || !on)) window.KimayaSongs.accompany(s, on); };
    v.title = "tap for sound";
    v.quiet = () => { if (!v.muted) { v.muted = true; songOn(false); } };
    v.addEventListener("click", (e) => {
      e.stopPropagation();
      if (v.muted) {
        // claim first (that mutes every other clip, including this one), then turn this one on
        window.dispatchEvent(new CustomEvent("kimaya:audio-claim", { detail: "clip" }));
        v.muted = false;
        v.currentTime = 0;
        v.play().catch(() => {});
        songOn(true);
      } else {
        v.quiet();
      }
    });
    window.addEventListener("kimaya:audio-claim", v.quiet);

    // only spend cpu on clips that are on screen
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([e]) => {
        if (e.isIntersecting) v.play().catch(() => {});
        else { v.quiet(); v.pause(); }
      }).observe(v);
    }
    return v;
  }

  window.KimayaClips = { supported, type, record, player, MAX_BYTES };
})();
