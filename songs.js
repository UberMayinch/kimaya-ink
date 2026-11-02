// a song on each photo: finds apple's 30s preview + one shared player + a chip ui
// mount anywhere: el.append(KimayaSongs.chip({ title: "...", artist: "...", itunesId? }))
// pick one: const p = KimayaSongs.picker(host); p.value() -> { title, artist, itunesId? } | null
//   p.el fires kimaya:song-pick { song } when a track is picked (song with itunesId) or dropped (null)
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

  // ---------- picker ----------
  // one box that asks apple as you type. picking a row keeps the exact track id, so the
  // chip later looks the song up by id instead of guessing from words. nothing picked:
  // the words still go through, "song — artist" if they wrote it that way.

  const searches = new Map(); // norm(term) -> promise of shaped results, for this page
  function search(term) {
    const k = norm(term);
    if (!searches.has(k)) {
      const p = limited(() => get("search", { term, entity: "song", media: "music", limit: 8 })).then((d) =>
        (d.results || []).filter((r) => r.kind === "song" && r.previewUrl).slice(0, 6).map(shape)
      );
      p.catch(() => searches.delete(k)); // network trouble: ask again next time
      searches.set(k, p);
    }
    return searches.get(k);
  }

  // "Song — Artist" / "Song - Artist" -> { title, artist }
  function split(text) {
    const m = /^(.*?)\s+[-–—]\s+(.*)$/.exec(text);
    return m ? { title: m[1].trim(), artist: m[2].trim() } : { title: text, artist: "" };
  }

  const small = (url) => (url || "").replace("/600x600bb.", "/80x80bb.");

  let pickers = 0;
  function picker(host, o = {}) {
    const id = `song-pick-${++pickers}`;
    const wrap = document.createElement("div");
    wrap.className = "song-pick";
    wrap.dataset.state = "empty";

    const box = document.createElement("div");
    box.className = "song-pick-box";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = o.max || 140;
    input.placeholder = o.placeholder || "♪ a song for it (optional)";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", id);

    const art = document.createElement("img");
    art.className = "song-pick-art";
    art.alt = "";
    art.hidden = true;

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "song-pick-clear";
    clear.textContent = "×";
    clear.setAttribute("aria-label", "remove the song");
    clear.hidden = true;

    const tail = document.createElement("span");
    tail.className = "song-pick-tail";
    tail.append(art, clear);

    const list = document.createElement("ul");
    list.className = "song-pick-list";
    list.id = id;
    list.setAttribute("role", "listbox");
    list.hidden = true;

    const hint = document.createElement("small");
    hint.className = "song-pick-hint";
    hint.hidden = true;

    box.append(input, tail);
    wrap.append(box, list, hint);
    if (host) host.append(wrap);

    let picked = null; // { title, artist, itunesId, artworkUrl }
    let rows = [];
    let active = -1;
    let timer = 0;
    let seq = 0;

    function say(text) {
      hint.textContent = text || "";
      hint.hidden = !text;
    }

    function close() {
      list.hidden = true;
      list.replaceChildren();
      rows = [];
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    function mark() {
      [...list.children].forEach((li, i) => {
        li.setAttribute("aria-selected", String(i === active));
        if (i === active) {
          input.setAttribute("aria-activedescendant", li.id);
          li.scrollIntoView({ block: "nearest" });
        }
      });
      if (active < 0) input.removeAttribute("aria-activedescendant");
    }

    function show(found) {
      rows = found;
      active = -1;
      list.replaceChildren(
        ...found.map((s, i) => {
          const li = document.createElement("li");
          li.id = `${id}-${i}`;
          li.setAttribute("role", "option");
          li.setAttribute("aria-selected", "false");
          const img = document.createElement("img");
          img.alt = "";
          img.loading = "lazy";
          img.src = small(s.artworkUrl);
          const name = document.createElement("span");
          name.className = "song-pick-name";
          name.textContent = s.title;
          const by = document.createElement("span");
          by.className = "song-pick-by";
          by.textContent = s.album && norm(s.album) !== norm(s.title) ? `${s.artist} · ${s.album}` : s.artist;
          li.append(img, name, by);
          // mousedown, not click: the input keeps focus, so no focusout closes the list first
          li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(s); });
          li.addEventListener("mousemove", () => { if (active !== i) { active = i; mark(); } });
          return li;
        })
      );
      list.hidden = !found.length;
      input.setAttribute("aria-expanded", String(!!found.length));
    }

    function choose(s) {
      picked = { title: s.title, artist: s.artist, itunesId: s.trackId, artworkUrl: s.artworkUrl };
      input.value = `${s.title} — ${s.artist}`;
      art.src = small(s.artworkUrl);
      art.hidden = !s.artworkUrl;
      clear.hidden = false;
      wrap.dataset.state = "picked";
      say("");
      close();
      wrap.dispatchEvent(new CustomEvent("kimaya:song-pick", { detail: { song: value() }, bubbles: true }));
    }

    function unpick() {
      const had = !!picked;
      picked = null;
      if (had) wrap.dispatchEvent(new CustomEvent("kimaya:song-pick", { detail: { song: null }, bubbles: true }));
      art.hidden = true;
      art.removeAttribute("src");
      wrap.dataset.state = input.value.trim() ? "typed" : "empty";
      clear.hidden = !input.value.trim();
    }

    function ask() {
      const term = input.value.trim();
      const my = ++seq;
      if (term.length < 2) { close(); say(""); wrap.dataset.state = term ? "typed" : "empty"; return; }
      wrap.dataset.state = "searching";
      search(term).then(
        (found) => {
          if (my !== seq) return;
          show(found);
          wrap.dataset.state = found.length ? "open" : "typed";
          say(found.length ? "" : "not on apple music. the words stay as written: song — artist");
        },
        () => {
          if (my !== seq) return;
          close();
          wrap.dataset.state = "typed";
          say("apple isn't answering. the words stay as written: song — artist");
        }
      );
    }

    input.addEventListener("input", () => {
      if (picked) unpick();
      else clear.hidden = !input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(ask, 350);
    });
    input.addEventListener("focus", () => { if (!picked && input.value.trim().length >= 2 && !rows.length) ask(); });
    input.addEventListener("keydown", (e) => {
      if (list.hidden) {
        if (e.key === "ArrowDown" && !picked && input.value.trim().length >= 2) { e.preventDefault(); ask(); }
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % rows.length; mark(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + rows.length) % rows.length; mark(); }
      else if (e.key === "Enter") { e.preventDefault(); choose(rows[active < 0 ? 0 : active]); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    wrap.addEventListener("focusout", (e) => { if (!wrap.contains(e.relatedTarget)) close(); });
    clear.addEventListener("click", () => { reset(); input.focus(); });

    function value() {
      if (picked) return { title: picked.title, artist: picked.artist, itunesId: picked.itunesId };
      const text = input.value.trim();
      return text ? split(text) : null;
    }

    function set(song) {
      clearTimeout(timer);
      seq++;
      close();
      say("");
      if (!song || !song.title) { reset(); return; }
      picked = song.itunesId ? { title: song.title, artist: song.artist || "", itunesId: song.itunesId, artworkUrl: "" } : null;
      input.value = song.artist ? `${song.title} — ${song.artist}` : song.title;
      art.hidden = true;
      clear.hidden = false;
      wrap.dataset.state = picked ? "picked" : "typed";
      if (picked) {
        // its cover, looked up by id so it is the right one
        resolve(song).then((s) => {
          if (picked && picked.itunesId === song.itunesId && s.artworkUrl) {
            picked.artworkUrl = s.artworkUrl;
            art.src = small(s.artworkUrl);
            art.hidden = false;
          }
        }, () => {});
      }
    }

    function reset() {
      clearTimeout(timer);
      seq++;
      input.value = "";
      unpick();
      close();
      say("");
    }

    return { el: wrap, input, value, set, reset };
  }

  const api = { resolve, play, pause, toggle, current, chip, picker, search, transport: "fetch" };
  window.KimayaSongs = api;
})();
