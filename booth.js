// photo booth + guestbook: front camera, real screen flash, short note, held for approval.
// open it from anywhere with: window.dispatchEvent(new Event("kimaya:booth"))

(() => {
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = LOCAL ? "http://localhost:8787/api" : "https://kimaya-guestbook.kimaya-ink.workers.dev/api";
  // localhost uses cloudflare's always-pass test key
  const SITEKEY = LOCAL ? "1x00000000000000000000AA" : "0x4AAAAAAFwc3Ol-4BaBxvkn";

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (d) => `'${pad(d.getFullYear() % 100)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}`;

  const booth = $("booth");
  const video = $("b-video");
  const shot = $("b-shot");
  const white = $("b-white");
  let stream = null;
  let blob = null;
  // movie mode lives in clips.js; here we only hold the result
  const Clips = window.KimayaClips;
  const canMovie = !!(Clips && Clips.supported());
  let mode = "photo";
  let clip = null; // a recorded movie or an uploaded video
  let clipView = null;
  let recStop = null;
  let takenOn = null;
  let shotUrl = null;

  function state(name) {
    booth.dataset.state = name;
  }

  // ---------- open / close ----------

  function open() {
    reset("camera");
    dropClip();
    $("b-err").textContent = "";
    state("intro");
    booth.hidden = false;
    $("b-start").focus();
    loadTurnstile();
  }

  function close() {
    stop();
    booth.hidden = true;
  }

  function stop() {
    if (recStop) recStop.abort();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }

  // ---------- camera ----------

  // camera shot or upload: what review shows and send posts
  function reset(source) {
    blob = null;
    clip = null;
    takenOn = null;
    booth.dataset.source = source;
    if (shotUrl) URL.revokeObjectURL(shotUrl);
    shotUrl = null;
    if (picker) picker.reset();
    if (window.KimayaUploads) KimayaUploads.preview($("b-up"), null);
    $("b-retake").textContent = source === "upload" ? "↺ PICK AGAIN" : "↺ RETAKE";
  }

  function uploaded(result) {
    stop();
    reset("upload");
    blob = result.photo;
    clip = result.clip || null;
    takenOn = result.takenOn || null;
    shotUrl = URL.createObjectURL(blob);
    shot.src = shotUrl;
    if (clip) KimayaUploads.preview($("b-up"), result);
    state("review");
    $("b-name").focus();
  }

  const picker = window.KimayaUploads ? KimayaUploads.mountPicker($("b-pick"), uploaded, { big: true, preview: false }) : null;

  async function start() {
    reset("camera");
    $("b-err").textContent = "";
    dropClip();
    try {
      const wantVideo = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: wantVideo, audio: true });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: wantVideo, audio: false }); // no mic: silent movies
      }
      video.srcObject = stream;
      await video.play();
      state("live");
      $("b-shutter").focus();
    } catch (err) {
      $("b-err").textContent = "camera blocked. allow camera access and try again.";
      state("intro");
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function shoot() {
    if (booth.dataset.state !== "live") return;
    state("count");
    for (const n of [3, 2, 1]) {
      $("b-count").textContent = n;
      await wait(700);
    }
    $("b-count").textContent = "";
    if (mode === "movie") return shootMovie();

    // the screen is the flash: go full white, let the face light up, then grab
    white.classList.add("on");
    await wait(220);
    capture();
    await wait(120);
    white.classList.remove("on");

    stop();
    state("review");
    $("b-name").focus();
  }

  // ---------- movie mode ----------

  function setMode(m) {
    mode = m === "movie" && canMovie ? "movie" : "photo";
    booth.dataset.mode = mode;
    booth.querySelectorAll(".booth-mode button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  }

  async function shootMovie() {
    state("rec");
    recStop = new AbortController();
    try {
      // the first frame doubles as the still (the api still wants a jpeg)
      clip = await Clips.record(stream, { video, signal: recStop.signal, onstart: capture });
    } catch (err) {
      clip = null;
      if (booth.hidden || !stream) return;
      $("b-err").textContent = err.message === "clip too big" ? "that clip came out too big, try again." : "movie mode failed here, try photo.";
      state("live");
      return;
    } finally {
      recStop = null;
    }
    clipView = Clips.player(URL.createObjectURL(clip), { poster: shot.src });
    shot.after(clipView);
    stop();
    state("review");
    $("b-name").focus();
  }

  function dropClip() {
    clip = null;
    if (!clipView) return;
    URL.revokeObjectURL(clipView.src);
    clipView.remove();
    clipView = null;
  }

  function capture() {
    const W = 640, H = 480;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d");

    // cover-crop, mirrored like the preview
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    g.save();
    g.translate(W, 0);
    g.scale(-1, 1);
    g.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    g.restore();

    // cheap CCD grade done by hand (ctx.filter isn't everywhere)
    const img = g.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], gr = d[i + 1], b = d[i + 2];
      const l = 0.299 * r + 0.587 * gr + 0.114 * b;
      r = l + (r - l) * 1.2;  gr = l + (gr - l) * 1.2;  b = l + (b - l) * 1.2;
      r = (r - 128) * 1.1 + 134; gr = (gr - 128) * 1.1 + 130; b = (b - 128) * 1.1 + 122;
      d[i] = r; d[i + 1] = gr; d[i + 2] = b;
    }
    g.putImageData(img, 0, 0);

    // orange date stamp
    g.font = '30px "VT323", monospace';
    g.textAlign = "right";
    g.textBaseline = "bottom";
    g.shadowColor = "rgba(255, 90, 0, .9)";
    g.shadowBlur = 8;
    g.fillStyle = "#ff8a1f";
    g.fillText(stamp(new Date()), W - 18, H - 12);

    shot.src = c.toDataURL("image/jpeg", 0.85);
    encode(c, 0.85);
  }

  function encode(c, q) {
    c.toBlob((b) => {
      if (b.size > 190 * 1024 && q > 0.5) return encode(c, q - 0.1);
      blob = b;
    }, "image/jpeg", q);
  }

  // ---------- turnstile ----------

  let tsReady = null;
  let tsWidget = null;

  function loadTurnstile() {
    if (tsReady) return tsReady;
    tsReady = new Promise((resolve, reject) => {
      window.__tsLoaded = () => resolve();
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__tsLoaded";
      s.async = true;
      s.onerror = () => { tsReady = null; reject(new Error("turnstile failed to load")); };
      document.head.append(s);
    });
    return tsReady;
  }

  async function token() {
    await loadTurnstile();
    return new Promise((resolve, reject) => {
      const opts = {
        sitekey: SITEKEY,
        execution: "execute",
        callback: resolve,
        "error-callback": () => reject(new Error("verification failed")),
      };
      // fresh widget per attempt so callbacks bind to this promise
      if (tsWidget !== null) window.turnstile.remove(tsWidget);
      tsWidget = window.turnstile.render("#b-ts", opts);
      window.turnstile.execute(tsWidget);
    });
  }

  // ---------- send ----------

  // the song box: searches apple as you type, so the exact track gets saved
  const songPick = $("b-song") && window.KimayaSongs ? KimayaSongs.picker($("b-song")) : null;

  async function send(e) {
    e.preventDefault();
    const name = $("b-name").value.trim();
    const message = $("b-msg").value.trim();
    if (!blob || !name || !message) return;

    const btn = $("b-send");
    btn.disabled = true;
    $("b-err").textContent = "";
    try {
      const form = new FormData();
      form.append("name", name);
      form.append("message", message);
      form.append("photo", blob, "shot.jpg");
      if (clip) form.append("clip", clip, clip.type.includes("mp4") ? "clip.mp4" : "clip.webm");
      if (takenOn) form.append("taken_on", takenOn);
      const song = songPick ? songPick.value() : null;
      if (song) {
        form.append("song_title", song.title);
        form.append("song_artist", song.artist || "");
        if (song.itunesId) form.append("song_itunes", song.itunesId);
      }
      form.append("token", await token());
      const r = await fetch(`${API}/posts`, { method: "POST", body: form });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "could not send");
      state("sent");
      $("b-name").value = "";
      $("b-msg").value = "";
      if (songPick) songPick.reset();
      $("b-left").textContent = "140";
    } catch (err) {
      $("b-err").textContent = `${err.message}.`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- guestbook wall ----------

  async function wall() {
    const el = $("guests");
    try {
      const r = await fetch(`${API}/posts`);
      if (!r.ok) throw 0;
      const { posts } = await r.json();
      el.innerHTML = "";
      if (!posts.length) {
        const p = document.createElement("p");
        p.className = "guests-empty";
        p.textContent = "no one yet. be the first.";
        el.append(p);
        return;
      }
      posts.forEach((p, i) => {
        const fig = document.createElement("figure");
        fig.className = "shot guest";
        fig.style.setProperty("--tilt", `${((i * 53) % 7) - 3}deg`);
        const frame = document.createElement("div");
        frame.className = "frame";
        const id = encodeURIComponent(p.id);
        const img = document.createElement("img");
        img.src = `${API}/photo/${encodeURIComponent(p.id)}`;
        img.alt = p.name ? `${p.name}'s picture` : p.message || "a picture";
        img.loading = "lazy";
        if (p.has_clip && Clips) {
          const v = Clips.player(`${API}/clip/${id}`, { poster: img.src });
          v.setAttribute("aria-label", img.alt);
          frame.append(v);
        } else {
          frame.append(img);
        }
        const cap = document.createElement("figcaption");
        cap.className = "label";
        cap.textContent = p.message;
        // owner uploads may have no name or caption; taken_on is the print's date
        const by = document.createElement("small");
        if (p.name) by.textContent = `— ${p.name}`;
        if (p.taken_on) {
          const d = document.createElement("span");
          d.className = "print-date";
          d.textContent = stamp(new Date(`${p.taken_on}T12:00:00`));
          by.append(d);
        }
        if (by.childNodes.length) cap.append(by);
        if (p.song && p.song.title && window.KimayaSongs) cap.append(window.KimayaSongs.chip(p.song));
        fig.append(frame, cap);
        el.append(fig);
      });
    } catch {
      el.innerHTML = "";
    }
  }

  // ---------- wire up ----------

  $("open-booth").addEventListener("click", open);
  window.addEventListener("kimaya:booth", open);
  $("b-close").addEventListener("click", close);
  $("b-start").addEventListener("click", start);
  $("b-shutter").addEventListener("click", shoot);
  $("b-retake").addEventListener("click", () => (booth.dataset.source === "upload" ? open() : start()));
  $("b-again").addEventListener("click", open);
  $("b-form").addEventListener("submit", send);
  booth.querySelectorAll(".booth-mode button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  booth.classList.toggle("no-movie", !canMovie);
  setMode("photo");
  $("b-msg").addEventListener("input", (e) => {
    $("b-left").textContent = 140 - e.target.value.length;
  });
  document.addEventListener("keydown", (e) => {
    if (booth.hidden) return;
    if (e.key === "Escape") close();
    if (e.key === " " && booth.dataset.state === "live") { e.preventDefault(); shoot(); }
  });

  wall();
})();
