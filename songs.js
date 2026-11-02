// a song on each photo: finds apple's 30s preview + one shared player + a chip ui
// mount anywhere: el.append(KimayaSongs.chip({ title: "...", artist: "..." }))
// events on window:
//   kimaya:song         detail { state: "playing" | "paused" | "ended", song }
//   kimaya:audio-claim  dispatch this from anything else that wants the speakers; songs pause

(() => {
  const API = "https://itunes.apple.com/";
  const CACHE_KEY = "kimaya.songs.v1";
  const HIT_TTL = 30 * 864e5; // 30 days
  const MISS_TTL = 864e5; // retry misses after a day
  const MIN_SCORE = 4;

  // ---------- matching ----------

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  // "Song (feat. X) - 2011 Remaster" -> "song"
  const base = (s) => norm(String(s || "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s[-–—]\s.*$/, ""));

  const words = (s) => new Set(norm(s).split(" ").filter(Boolean));

  function overlap(a, b) {
    const A = words(a), B = words(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    A.forEach((w) => B.has(w) && n++);
    return n / Math.max(A.size, B.size);
  }

  function near(a, b, full, part) {
    if (!a || !b) return 0;
    if (a === b) return full;
    if (a.includes(b) || b.includes(a)) return part;
    return overlap(a, b) * part;
  }

  // versions nobody means unless they ask for them
  const OFF = ["cover", "karaoke", "instrumental", "tribute", "remix", "live", "acoustic", "lullaby",
    "sped up", "slowed", "made famous", "originally performed", "in the style of", "8 bit", "piano version"];

  function score(r, song) {
    if (!r || !r.previewUrl || r.kind !== "song") return -Infinity;
    let s = near(base(r.trackName), base(song.title), 4, 2);
    s += near(norm(r.artistName), norm(song.artist), 4, 2.5);
    const asked = ` ${norm(song.title)} ${norm(song.artist)} `;
    const got = ` ${norm(r.trackName)} ${norm(r.collectionName)} ${norm(r.artistName)} `;
    OFF.forEach((w) => {
      if (got.includes(` ${w} `) && !asked.includes(` ${w} `)) s -= 3;
    });
    return s;
  }

  function best(results, song) {
    let top = null, topScore = MIN_SCORE - 0.001;
    (results || []).forEach((r) => {
      const s = score(r, song);
      if (s > topScore) { top = r; topScore = s; }
    });
    return top;
  }

  function shape(r) {
    return {
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName || "",
      trackId: r.trackId,
      previewUrl: r.previewUrl,
      artworkUrl: (r.artworkUrl100 || "").replace(/\/\d+x\d+bb\./, "/600x600bb."),
      trackUrl: r.trackViewUrl || "",
    };
  }

  // ---------- network ----------

  // itunes sends access-control-allow-origin: *, jsonp is only a fallback
  function jsonp(url) {
    return new Promise((ok, fail) => {
      const cb = `__kimayaSong${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const el = document.createElement("script");
      const done = () => { delete window[cb]; el.remove(); clearTimeout(t); };
      const t = setTimeout(() => { done(); fail(new Error("jsonp timeout")); }, 8000);
      window[cb] = (data) => { done(); ok(data); };
      el.onerror = () => { done(); fail(new Error("jsonp failed")); };
      el.src = `${url}&callback=${cb}`;
      document.head.append(el);
    });
  }

  function get(path, params) {
    const url = API + path + "?" + new URLSearchParams(params);
    if (api.transport === "jsonp") return jsonp(url);
    // only a blocked/failed request falls back; a 403 (rate limit) shouldn't cost a second call
    return fetch(url)
      .catch((err) => (typeof document !== "undefined" ? jsonp(url).then((d) => ({ ok: true, json: () => d })) : Promise.reject(err)))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`itunes ${r.status}`))));
  }

  // itunes allows ~20 calls a minute, so keep it to two at a time
  const queue = [];
  let busy = 0;
  function limited(fn) {
    return new Promise((ok, fail) => {
      queue.push(() => fn().then(ok, fail).finally(() => { busy--; next(); }));
      next();
    });
  }
  function next() {
    while (busy < 2 && queue.length) { busy++; queue.shift()(); }
  }

  // ---------- cache ----------

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
  }
  function writeCache(key, s) {
    try {
      const all = readCache();
      all[key] = { t: Date.now(), s };
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch { /* private mode or full, fine */ }
  }
  function forget(key) {
    try {
      const all = readCache();
      delete all[key];
      localStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch { /* fine */ }
    inflight.delete(key);
  }

  const keyOf = (song) => (song.itunesId ? `id:${song.itunesId}` : `${norm(song.title)}|${norm(song.artist)}`);

  // ---------- resolve ----------

  const inflight = new Map();

  function lookup(song) {
    if (song.itunesId) {
      return limited(() => get("lookup", { id: song.itunesId, entity: "song" }))
        .then((d) => (d.results || []).find((r) => r.previewUrl) || null);
    }
    const term = (t, limit) => limited(() => get("search", { term: t, entity: "song", limit }));
    return term(`${song.title} ${song.artist}`, 5).then((d) => {
      const hit = best(d.results, song);
      if (hit || !d.resultCount) return hit;
      // results came back but none fit: one wider try on the title alone
      return term(song.title, 25).then((d2) => best(d2.results, song));
    });
  }

  function resolve(song) {
    if (!song || (!song.itunesId && !(song.title && song.artist))) return Promise.reject(new Error("need title + artist"));
    const key = keyOf(song);
    const hit = readCache()[key];
    if (hit && Date.now() - hit.t < (hit.s ? HIT_TTL : MISS_TTL)) {
      return hit.s ? Promise.resolve({ ...hit.s, key }) : Promise.reject(new Error("no match"));
    }
    if (inflight.has(key)) return inflight.get(key);

    const p = lookup(song).then((r) => {
      const s = r ? shape(r) : null;
      writeCache(key, s);
      if (!s) throw new Error("no match");
      return { ...s, key };
    });
    // network errors aren't cached, so let the next ask try again
    p.catch(() => inflight.get(key) === p && !readCache()[key] && inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // ---------- one shared player ----------

  let audio = null;
  let cur = null; // resolved song in the player
  let swallowPause = false;
  const chips = new Set(); // WeakRef<chip>, so removed chips can be collected

  function emit(state, song) {
    window.dispatchEvent(new CustomEvent("kimaya:song", { detail: { state, song } }));
  }

  function player() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = "none";
    // a new src can drop the queued pause we meant to swallow, so never let the flag outlive the load
    audio.addEventListener("loadstart", () => { swallowPause = false; });
    audio.addEventListener("playing", () => { emit("playing", cur); sync(); });
    audio.addEventListener("pause", () => {
      if (swallowPause) { swallowPause = false; return; }
      if (!audio.ended) emit("paused", cur);
      sync();
    });
    audio.addEventListener("ended", () => { emit("ended", cur); sync(); });
    audio.addEventListener("timeupdate", sync);
    audio.addEventListener("error", () => {
      if (!cur) return;
      forget(cur.key); // preview url probably moved, look it up fresh next time
      emit("paused", cur);
      sync();
    });
    return audio;
  }

  function mediaSession(s) {
    if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: s.title,
      artist: s.artist,
      album: s.album || "",
      artwork: s.artworkUrl ? [{ src: s.artworkUrl, sizes: "600x600", type: "image/jpeg" }] : [],
    });
  }

  function play(s) {
    if (!s || !s.previewUrl) return Promise.reject(new Error("nothing to play"));
    const a = player();
    if (!cur || cur.previewUrl !== s.previewUrl) {
      // switching: drop the old song's pause so a ducked soundtrack doesn't pop back up
      if (cur && !a.paused) swallowPause = true;
      a.pause();
      cur = s;
      a.src = s.previewUrl;
      mediaSession(s);
    } else if (a.ended) {
      a.currentTime = 0;
    }
    sync();
    return a.play().catch((err) => {
      if (cur.previewUrl !== s.previewUrl) throw err; // another song took over, it reports for itself
      swallowPause = false;
      emit("paused", cur);
      sync();
      throw err;
    });
  }

  function pause() {
    if (audio && !audio.paused) audio.pause();
  }

  const isOn = (s) => !!(audio && cur && s && cur.previewUrl === s.previewUrl && !audio.paused && !audio.ended);

  function toggle(s) {
    if (isOn(s)) { pause(); return Promise.resolve(); }
    return play(s);
  }

  function current() {
    if (!cur) return null;
    return {
      song: cur,
      playing: isOn(cur),
      time: audio.currentTime || 0,
      duration: audio.duration || 30,
    };
  }

  window.addEventListener("kimaya:audio-claim", pause);

  // ---------- chip ----------

  function sync() {
    chips.forEach((ref) => {
      const el = ref.deref();
      if (el) el._sync();
      else chips.delete(ref);
    });
  }

  function chip(song) {
    const wrap = document.createElement("span");
    wrap.className = "song-chip";
    wrap.dataset.state = "loading";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "song-play";

    const icon = document.createElement("span");
    icon.className = "song-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "♪";

    const text = document.createElement("span");
    text.className = "song-text";
    text.textContent = `${song.title || ""} — ${song.artist || ""}`;

    const bar = document.createElement("span");
    bar.className = "song-bar";
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("i");
    bar.append(fill);

    btn.append(icon, text, bar);

    const link = document.createElement("a");
    link.className = "song-link";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "listen in Apple Music ↗";
    link.hidden = true;

    wrap.append(btn, link);

    let resolved = null;
    const label = `${song.title} by ${song.artist}`;
    btn.setAttribute("aria-label", `${label}, finding preview`);

    wrap._sync = () => {
      if (!resolved) return;
      const mine = cur && cur.previewUrl === resolved.previewUrl;
      const on = isOn(resolved);
      const t = mine ? audio.currentTime || 0 : 0;
      const d = mine ? audio.duration || 30 : 30;
      wrap.dataset.state = on ? "playing" : mine && t > 0 && !audio.ended ? "paused" : "ready";
      icon.textContent = on ? "❚❚" : wrap.dataset.state === "paused" ? "▶" : "♪";
      btn.setAttribute("aria-pressed", String(on));
      btn.setAttribute("aria-label", `${on ? "pause" : "play"} preview: ${label}`);
      fill.style.width = `${mine && !audio.ended ? Math.min(100, (t / d) * 100) : 0}%`;
    };

    // don't let the click reach whatever the chip is mounted on (a print, the camera)
    wrap.addEventListener("click", (e) => e.stopPropagation());

    btn.addEventListener("click", () => {
      if (!resolved) return;
      toggle(resolved).catch(() => {});
    });

    resolve(song).then(
      (s) => {
        resolved = s;
        if (s.trackUrl) {
          link.href = s.trackUrl;
          link.hidden = false;
        }
        chips.add(new WeakRef(wrap));
        wrap._sync();
      },
      () => {
        // no preview: keep the words, lose the button behaviour
        wrap.dataset.state = "off";
        btn.disabled = true;
        btn.setAttribute("aria-label", label);
      }
    );

    return wrap;
  }

  const api = { resolve, play, pause, toggle, current, chip, transport: "fetch" };
  window.KimayaSongs = api;
})();
