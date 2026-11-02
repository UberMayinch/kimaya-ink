// guestbook api client shared by the camera LCD and the fallback booth.
// window.KimayaGuestbook: { API, list(), photoURL(id), clipURL(id), post(fields) }

(() => {
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const API = LOCAL ? "http://localhost:8787/api" : "https://kimaya-guestbook.kimaya-ink.workers.dev/api";
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

  async function post({ name, message, photo, clip, takenOn }) {
    const form = new FormData();
    form.append("name", name);
    form.append("message", message);
    form.append("photo", photo, "shot.jpg");
    if (clip) form.append("clip", clip, clip.type.includes("mp4") ? "clip.mp4" : "clip.webm");
    if (takenOn) form.append("taken_on", takenOn);
    form.append("token", await token());
    const r = await fetch(`${API}/posts`, { method: "POST", body: form });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "could not send");
    return data;
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
    loadTurnstile,
    photoURL: (id) => `${API}/photo/${encodeURIComponent(id)}`,
    clipURL: (id) => `${API}/clip/${encodeURIComponent(id)}`,
  };
})();
