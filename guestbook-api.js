// guestbook api client shared by the camera LCD and the fallback booth.
// window.KimayaGuestbook: { API, list(), photoURL(id), clipURL(id), post(fields), postMany(fields) }
//   post({ name, message, photo, clip?, takenOn?, song? })  song: { title, artist, itunesId? } (optional)
//   postMany({ name, message, items: [{ photo, clip?, takenOn?, message? }], onProgress? })
//     several at once in one request (one verification, one turn of the per-ip limit); an item's own
//     message replaces the shared one. resolves { ok, status, count }

(() => {
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // ?api=http://127.0.0.1:8788/api points a local page at another local worker (dev only)
  const API = (LOCAL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api$/.test(new URLSearchParams(location.search).get("api") || "") && new URLSearchParams(location.search).get("api")) || (LOCAL ? "http://localhost:8787/api" : "https://kimaya-guestbook.kimaya-ink.workers.dev/api");
  // localhost uses cloudflare's always-pass test key
  const SITEKEY = LOCAL ? "1x00000000000000000000AA" : "0x4AAAAAAFwc3Ol-4BaBxvkn";

  let tsReady = null;
  let tsWidget = null;

  function loadTurnstile() {
    if (tsReady) return tsReady;
    tsReady = new Promise((resolve, reject) => {
      window.__kgTsLoaded = () => resolve();
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__kgTsLoaded";
      s.async = true;
      s.onerror = () => { tsReady = null; reject(new Error("verification failed to load")); };
      document.head.append(s);
    });
    return tsReady;
  }

  // the widget needs a home in the dom even though it's invisible
  function tsHost() {
    let el = document.getElementById("kg-ts");
    if (!el) {
      el = document.createElement("div");
      el.id = "kg-ts";
      el.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(el);
    }
    return el;
  }

  async function token() {
    await loadTurnstile();
    return new Promise((resolve, reject) => {
      if (tsWidget !== null) window.turnstile.remove(tsWidget);
      tsWidget = window.turnstile.render(tsHost(), {
        sitekey: SITEKEY,
        execution: "execute",
        callback: resolve,
        "error-callback": () => reject(new Error("verification failed")),
      });
      window.turnstile.execute(tsWidget);
    });
  }

  function fill(form, { photo, clip, takenOn }, s = "") {
    form.append(`photo${s}`, photo, "shot.jpg");
    if (clip) form.append(`clip${s}`, clip, clip.type.includes("mp4") ? "clip.mp4" : "clip.webm");
    if (takenOn) form.append(`taken_on${s}`, takenOn);
  }

  async function send(form) {
    form.append("token", await token());
    const r = await fetch(`${API}/posts`, { method: "POST", body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || "could not send"), { status: r.status });
    return data;
  }

  async function post({ name, message, photo, clip, takenOn, song }) {
    const form = new FormData();
    form.append("name", name);
    form.append("message", message);
    fill(form, { photo, clip, takenOn });
    if (song && song.title) {
      form.append("song_title", song.title);
      form.append("song_artist", song.artist || "");
      if (song.itunesId) form.append("song_itunes", song.itunesId);
    }
    return send(form);
  }

  async function postMany({ name, message, items, onProgress }) {
    if (!items || !items.length) throw new Error("nothing to send");
    if (items.length === 1) return post({ ...items[0], name, message: items[0].message || message });
    const form = new FormData();
    form.append("name", name);
    form.append("message", message);
    items.forEach((it, i) => {
      fill(form, it, `.${i}`);
      if (it.message) form.append(`message.${i}`, it.message);
    });
    try {
      return await send(form);
    } catch (err) {
      // a guestbook from before drops answers "photo required": send them one at a time instead
      if (err.status !== 400 || !/photo required/.test(err.message)) throw err;
    }
    let n = 0;
    for (const it of items) {
      if (onProgress) onProgress(n, items.length);
      try {
        await post({ ...it, name, message: it.message || message });
      } catch (err) {
        throw new Error(n ? `${err.message} (${n} of ${items.length} went through)` : err.message);
      }
      n++;
    }
    return { ok: true, status: "pending", count: n };
  }

  async function list() {
    const r = await fetch(`${API}/posts`);
    if (!r.ok) throw new Error(`error ${r.status}`);
    return (await r.json()).posts;
  }

  window.KimayaGuestbook = {
    API,
    list,
    post,
    postMany,
    loadTurnstile,
    photoURL: (id) => `${API}/photo/${encodeURIComponent(id)}`,
    clipURL: (id) => `${API}/clip/${encodeURIComponent(id)}`,
  };
})();
