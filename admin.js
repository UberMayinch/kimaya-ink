// approve or delete guestbook posts. token lives in sessionStorage only.

const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const API = LOCAL ? "http://localhost:8787/api" : "https://kimaya-guestbook.kimaya-ink.workers.dev/api";

const $ = (id) => document.getElementById(id);
const blobs = [];

const auth = () => ({ Authorization: `Bearer ${sessionStorage.getItem("kimaya-admin") || ""}` });

async function call(path, opts = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...auth(), ...(opts.headers || {}) } });
  if (r.status === 401) throw new Error("wrong token");
  if (!r.ok) throw new Error(`error ${r.status}`);
  return r;
}

// pending media needs the token, so fetch it as a blob url
function media(path, set) {
  call(path)
    .then((r) => r.blob())
    .then((b) => {
      const url = URL.createObjectURL(b);
      blobs.push(url);
      set(url);
    })
    .catch(() => {});
}

function card(p, pending) {
  const el = document.createElement("div");
  el.className = "card";
  const id = encodeURIComponent(p.id);
  // movie posts loop their clip instead of the still
  const movie = p.has_clip && window.KimayaClips;
  const pic = movie ? KimayaClips.player("") : document.createElement("img");
  if (!movie) pic.alt = "";
  media(`/admin/photo/${id}`, (url) => { movie ? (pic.poster = url) : (pic.src = url); });
  if (movie) media(`/admin/clip/${id}`, (url) => { pic.src = url; });
  const msg = document.createElement("p");
  msg.textContent = p.message;
  const by = document.createElement("small");
  by.textContent = `${p.name} · ${new Date(p.created_at).toLocaleString()}`;

  const row = document.createElement("div");
  row.className = "row";
  if (pending) {
    const ok = document.createElement("button");
    ok.className = "hud-btn";
    ok.textContent = "APPROVE";
    ok.onclick = () => act(`/admin/posts/${encodeURIComponent(p.id)}/approve`, "POST");
    row.append(ok);
  }
  const del = document.createElement("button");
  del.className = "hud-btn del";
  del.textContent = "DELETE";
  del.onclick = () => {
    if (confirm(`Delete ${p.name}'s post? This can't be undone.`)) act(`/admin/posts/${encodeURIComponent(p.id)}`, "DELETE");
  };
  row.append(del);

  el.append(pic, msg, by, row);
  return el;
}

async function act(path, method) {
  try {
    await call(path, { method });
    load();
  } catch (e) {
    $("status").textContent = e.message;
  }
}

async function load() {
  $("status").textContent = "";
  blobs.splice(0).forEach(URL.revokeObjectURL);
  try {
    const [pending, live] = await Promise.all([
      call("/admin/pending").then((r) => r.json()),
      fetch(`${API}/posts`, { cache: "no-store" }).then((r) => r.json()),
    ]);
    $("pending").replaceChildren(...pending.posts.map((p) => card(p, true)));
    $("live").replaceChildren(...live.posts.map((p) => card(p, false)));
    if (!pending.posts.length) $("status").textContent = "nothing waiting.";
  } catch (e) {
    $("status").textContent = e.message;
  }
}

$("login").addEventListener("submit", (e) => {
  e.preventDefault();
  sessionStorage.setItem("kimaya-admin", $("token").value.trim());
  $("token").value = "";
  load();
});

if (sessionStorage.getItem("kimaya-admin")) load();
