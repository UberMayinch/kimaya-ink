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
let current = 0;

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
    const btn = document.createElement("button");
    btn.className = "shot";
    btn.style.setProperty("--tilt", `${((i * 37) % 7) - 3}deg`);
    btn.setAttribute("aria-label", p.caption || dscName(i));

    const frame = document.createElement("div");
    frame.className = "frame";
    const img = document.createElement("img");
    img.src = p.file;
    img.alt = p.caption || "";
    img.loading = "lazy";
    const s = document.createElement("span");
    s.className = "stamp";
    s.textContent = stamp(p.date);
    frame.append(img, s);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = p.caption || dscName(i);

    btn.append(frame, label);
    btn.addEventListener("click", () => open(i));
    roll.append(withSong(btn, p.song));
  });
}

function show(i) {
  current = (i + photos.length) % photos.length;
  const p = photos[current];
  $("v-img").src = p.file;
  $("v-img").alt = p.caption || "";
  $("v-stamp").textContent = stamp(p.date);
  $("v-name").textContent = dscName(current);
  $("v-pos").textContent = `${current + 1}/${photos.length}`;

  const cap = $("v-cap");
  cap.textContent = p.caption || "";
  if (p.by) {
    const by = document.createElement("small");
    by.textContent = `shot by ${p.by}`;
    cap.append(by);
  }
  if (p.song && window.KimayaSongs) cap.append(KimayaSongs.chip(p.song));
}

function open(i) {
  flash();
  show(i);
  $("viewer").hidden = false;
  $("v-close").focus();
}

function close() {
  $("viewer").hidden = true;
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

// 3D hero lives in camera.js; if it never comes up, fall back to the flat title
setTimeout(() => {
  const stage = $("stage");
  if (stage && !stage.classList.contains("live")) stage.classList.add("dead");
}, 8000);

fetch("photos.json", { cache: "no-cache" })
  .then((r) => r.json())
  .then((list) => {
    // newest first
    photos = list.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    render();
  })
  .catch(() => render());
