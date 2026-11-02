// approve or delete guestbook posts. token lives in sessionStorage only.

const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const API = LOCAL ? "http://localhost:8787/api" : "https://kimaya-guestbook.kimaya-ink.workers.dev/api";

const $ = (id) => document.getElementById(id);
const blobs = [];

const auth = () => ({ Authorization: `Bearer ${sessionStorage.getItem("kimaya-admin") || ""}` });

async function call(path, opts = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...auth(), ...(opts.headers || {}) } });
  if (r.status === 401) throw new Error("wrong token");
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `error ${r.status}`);
  }
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
  by.textContent = `${p.name || "(no name)"} · ${new Date(p.created_at).toLocaleString()}`;
  if (p.taken_on) {
    const d = document.createElement("span");
    d.className = "print-date";
    d.textContent = `${KimayaUploads.stamp(p.taken_on)} · `;
    by.prepend(d);
  }

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

// ---------- add to gallery: many files, prepared here, posted one by one as approved ----------

const items = [];

function field(placeholder, max, value = "") {
  const i = document.createElement("input");
  i.placeholder = placeholder;
  if (max) i.maxLength = max;
  i.value = value;
  return i;
}

function addItem(result, file) {
  const it = { result, file, done: false, busy: null };
  const row = document.createElement("div");
  row.className = "item";
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  KimayaUploads.preview(thumb, result);

  const caption = field("caption (optional)", 140);
  const name = field("name (optional)", 24);
  const date = field("", 0, result.takenOn || "");
  date.type = "date";
  date.min = "1900-01-01";
  date.max = new Date().toISOString().slice(0, 10);
  const state = document.createElement("small");
  state.className = "state";
  state.textContent = `${file.name} · ${result.takenOn ? "date from photo" : "no date found"}`;
  const drop = document.createElement("button");
  drop.type = "button";
  drop.className = "hud-btn del";
  drop.textContent = "×";
  drop.setAttribute("aria-label", "remove");

  // a new date means a new burned-in stamp, so prepare again
  date.addEventListener("change", () => {
    state.textContent = "restamping…";
    it.busy = KimayaUploads.prepare(file, { takenOn: date.value || undefined })
      .then((r) => {
        it.result = r;
        date.value = r.takenOn || ""; // cleared -> falls back to the exif date
        KimayaUploads.preview(thumb, r);
        state.textContent = r.takenOn ? `stamped ${KimayaUploads.stamp(r.takenOn)}` : "no date";
      })
      .catch((e) => { state.textContent = e.message; })
      .finally(() => { it.busy = null; });
  });
  drop.addEventListener("click", () => {
    items.splice(items.indexOf(it), 1);
    KimayaUploads.preview(thumb, null);
    row.remove();
  });

  const line = document.createElement("div");
  line.append(name, date, drop);
  const fields = document.createElement("div");
  fields.className = "fields";
  fields.append(caption, line, state);
  row.append(thumb, fields);
  Object.assign(it, { row, caption, name, date, state });
  items.push(it);
  $("add-list").append(row);
}

async function uploadAll() {
  const btn = $("add-send");
  btn.disabled = true;
  for (const it of items.filter((x) => !x.done)) {
    if (it.busy) await it.busy;
    it.row.classList.remove("err");
    it.state.textContent = "sending…";
    try {
      const { photo, clip } = it.result;
      const form = new FormData();
      form.append("name", it.name.value.trim() || $("add-by").value.trim());
      form.append("message", it.caption.value.trim());
      if (it.date.value) form.append("taken_on", it.date.value);
      form.append("photo", photo, "shot.jpg");
      if (clip) form.append("clip", clip, clip.type === "video/mp4" ? "clip.mp4" : "clip.webm");
      await call("/admin/posts", { method: "POST", body: form });
      it.done = true;
      it.row.classList.add("done");
      it.state.textContent = "✓ live";
    } catch (e) {
      it.row.classList.add("err");
      it.state.textContent = e.message;
    }
  }
  btn.disabled = false;
  load();
}

KimayaUploads.mountPicker($("add-pick"), addItem, { multiple: true, preview: false, big: true, label: "⇪ CHOOSE FILES" });
$("add-send").addEventListener("click", uploadAll);

$("login").addEventListener("submit", (e) => {
  e.preventDefault();
  sessionStorage.setItem("kimaya-admin", $("token").value.trim());
  $("token").value = "";
  load();
});

if (sessionStorage.getItem("kimaya-admin")) load();
