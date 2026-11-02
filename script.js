// renders photos.json as a roll of digicam prints + a playback viewer

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");

// "2026-11-02" -> "'26 11 02", the classic orange stamp
function stamp(dateStr) {
  const d = dateStr ? new Date(dateStr + "T12:00:00") : new Date();
  if (isNaN(d)) return "";
  return `'${pad(d.getFullYear() % 100)} ${pad(d.getMonth() + 1)} ${pad(d.getDate())}`;
}

const dscName = (i) => `DSC_${String(i + 1).padStart(4, "0")}.JPG`;

// a print with a song can't be one big button (the chip is a button too),
// so the paper becomes a div and the photo part opens the viewer
function withSong(btn, song) {
  if (!song || !window.KimayaSongs) return btn;
  const print = document.createElement("div");
  print.className = "shot has-song";
  print.style.cssText = btn.style.cssText;
  btn.className = "shot-open";
  btn.removeAttribute("style");
  print.append(btn, KimayaSongs.chip(song));
  return print;
}

function flash() {
  const el = document.querySelector(".flash");
  el.classList.remove("on");
  void el.offsetWidth; // restart animation
  el.classList.add("on");
}

let photos = [];
let viewable = [];
let current = 0;
let vClip = null; // viewer's movie player, made on first use

// curated clips: "clip" in photos.json, "file" doubles as the poster
const hasClip = (p) => !!(p.clip && window.KimayaClips);

function render() {
  const roll = $("roll");
  roll.innerHTML = "";
  $("count").textContent = `[ ${photos.length} ]`;

  if (!photos.length) {
    roll.innerHTML = `
      <div class="empty">
        <strong>NO IMAGE</strong>
        <span>card is waiting for its first picture</span>
      </div>`;
    return;
  }

  photos.forEach((p, i) => {
    // letters and voice notes (see CONTRIBUTING.md) print as paper too, without the viewer
    if (p.type === "letter" || p.type === "audio") return roll.append(paperNote(p, i));

    const n = viewable.indexOf(p);
    const btn = document.createElement("button");
    btn.className = "shot";
    btn.style.setProperty("--tilt", `${((i * 37) % 7) - 3}deg`);
    btn.setAttribute("aria-label", p.caption || dscName(n));

    const frame = document.createElement("div");
    frame.className = "frame";
    const img = document.createElement("img");
    img.src = p.file;
    img.alt = p.caption || "";
    img.loading = "lazy";
    const s = document.createElement("span");
    s.className = "stamp";
    s.textContent = stamp(p.date);
    frame.append(hasClip(p) ? KimayaClips.player(p.clip, { poster: p.file, song: p.song }) : img, s);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = p.caption || dscName(n);

    btn.append(frame, label);
    btn.addEventListener("click", () => open(viewable.indexOf(p)));
    roll.append(withSong(btn, p.song));
  });
}

function paperNote(p, i) {
  const fig = document.createElement("figure");
  fig.className = "shot guest note";
  fig.style.setProperty("--tilt", `${((i * 37) % 7) - 3}deg`);
  const frame = document.createElement("div");
  frame.className = "frame note-frame";
  if (p.type === "letter") {
    const txt = document.createElement("p");
    txt.className = "note-text";
    txt.textContent = p.text || "";
    frame.append(txt);
  } else {
    const a = document.createElement("audio");
    a.controls = true;
    a.preload = "none";
    a.src = p.file;
    frame.append(a);
  }
  const s = document.createElement("span");
  s.className = "stamp";
  s.textContent = stamp(p.date);
  frame.append(s);
  const cap = document.createElement("figcaption");
  cap.className = "label";
  cap.textContent = p.title || p.caption || (p.type === "letter" ? "a letter" : "a voice note");
  if (p.by) {
    const by = document.createElement("small");
    by.textContent = `— ${p.by}`;
    cap.append(by);
  }
  fig.append(frame, cap);
  return fig;
}

function show(i) {
  current = (i + viewable.length) % viewable.length;
  const p = viewable[current];
  $("v-img").src = p.file;
  $("v-img").alt = p.caption || "";
  showClip(hasClip(p) ? p : null);
  $("v-stamp").textContent = stamp(p.date);
  $("v-name").textContent = dscName(current);
  $("v-pos").textContent = `${current + 1}/${viewable.length}`;

  const cap = $("v-cap");
  cap.textContent = p.caption || "";
  if (p.by) {
    const by = document.createElement("small");
    by.textContent = `shot by ${p.by}`;
    cap.append(by);
  }
  if (p.song && window.KimayaSongs) cap.append(KimayaSongs.chip(p.song));
}

function showClip(p) {
  if (!p) {
    $("v-img").hidden = false;
    if (vClip) {
      vClip.quiet();
      vClip.pause();
      vClip.hidden = true;
      vClip.removeAttribute("src");
      vClip.load();
    }
    return;
  }
  if (!vClip) {
    vClip = KimayaClips.player("", { song: () => viewable[current]?.song });
    $("v-img").after(vClip);
  }
  vClip.quiet();
  vClip.poster = p.file;
  vClip.src = p.clip;
  vClip.hidden = false;
  $("v-img").hidden = true;
  vClip.play().catch(() => {});
}

function open(i) {
  flash();
  show(i);
  $("viewer").hidden = false;
  $("v-close").focus();
}

function close() {
  $("viewer").hidden = true;
  showClip(null);
}

$("v-prev").addEventListener("click", () => show(current - 1));
$("v-next").addEventListener("click", () => show(current + 1));
$("v-close").addEventListener("click", close);
$("viewer").addEventListener("click", (e) => {
  if (e.target.id === "viewer") close();
});
document.addEventListener("keydown", (e) => {
  if ($("viewer").hidden) return;
  if (e.key === "Escape") close();
  if (e.key === "ArrowLeft") show(current - 1);
  if (e.key === "ArrowRight") show(current + 1);
});

$("today").textContent = stamp();

// 3D journey lives in journey.js; if it never comes up, show the still
setTimeout(() => {
  const j = $("journey");
  if (j && !j.classList.contains("live")) j.classList.add("dead");
}, 10000);

fetch("photos.json", { cache: "no-cache" })
  .then((r) => r.json())
  .then((list) => {
    // newest first
    photos = list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    viewable = photos.filter((p) => p.type !== "letter" && p.type !== "audio");
    render();
  })
  .catch(() => render());
