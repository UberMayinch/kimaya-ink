// the memory archive's data adapter: one list of typed items from the sources the site already has.
//
//   photos.json  -> photo / clip / letter / audio items (curated, committed)
//   guestbook    -> photo / clip items with the visitor's note (window.KimayaGuestbook, approved posts)
//
// item: { id, type: "photo"|"clip"|"letter"|"audio", src, clip, text, audio, title, date, caption, by, song, dsc }
//   src    poster/photo url (photo, clip, and an optional cover for audio/letter)
//   clip   video url (clip)
//   audio  audio url (audio)
//   text   the letter body (letter), paragraphs split on blank lines
//   dsc    "100-0007" style file number, newest first
//
// ?demo=1 adds placeholder items of every type so the LCD can be exercised with an empty card.
// nothing here talks to a new backend.

const TYPES = new Set(["photo", "clip", "letter", "audio"]);

export function dscName(i) {
  return `100-${String(i + 1).padStart(4, "0")}`;
}

export function isoDate(v) {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

function fromPhotosJson(list) {
  return list.map((p, i) => {
    const type = TYPES.has(p.type) ? p.type : p.clip ? "clip" : "photo";
    return {
      id: `card-${i}`,
      type,
      src: type === "audio" ? "" : p.file || "",
      clip: type === "clip" ? p.clip || "" : "",
      audio: type === "audio" ? p.file || "" : "",
      text: type === "letter" ? String(p.text || "") : "",
      title: p.title || "",
      date: isoDate(p.date),
      caption: p.caption || "",
      by: p.by || "",
      song: p.song || null,
      cover: type === "audio" || type === "letter" ? p.cover || "" : "",
    };
  });
}

function fromGuestbook(posts, gb) {
  return posts.map((p) => ({
    id: `guest-${p.id}`,
    type: p.text ? "letter" : p.has_clip ? "clip" : "photo",
    // own cache key: a non-cors <img> of the same url elsewhere would taint the LCD canvas
    src: p.text ? "" : `${gb.photoURL(p.id)}?lcd`,
    clip: p.has_clip ? `${gb.clipURL(p.id)}?lcd` : "",
    audio: "",
    text: p.text || "",
    title: p.text ? p.message || "" : "", // a letter's note is its title
    date: p.taken_on || isoDate(p.created_at),
    caption: p.text ? "" : p.message || "",
    by: p.name || "",
    song: p.song && p.song.title ? p.song : null,
    cover: "",
    stamped: true, // the booth burns its own orange date into the picture
  }));
}

// dev only: never real content, never committed as content
function demoItems() {
  const tiny = (w, h, draw) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    draw(c.getContext("2d"), w, h);
    return c.toDataURL("image/png");
  };
  const swatch = (a, b) =>
    tiny(320, 240, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, h);
      gr.addColorStop(0, a);
      gr.addColorStop(1, b);
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,.35)";
      for (let i = 0; i < 40; i++) g.fillRect((i * 97) % w, (i * 53) % h, 6, 6);
    });
  return [
    { id: "demo-1", type: "photo", src: swatch("#ff8aa8", "#ffd36b"), date: "2023-10-29", caption: "the mirror one", by: "demo", song: null },
    { id: "demo-2", type: "letter", title: "a letter", text: "dear kimaya,\n\nthis is a placeholder letter so the LCD has something to page through. it is a few lines long, on purpose, so that the paging can be checked.\n\nreal letters come from photos.json.\n\n— demo", date: "2024-03-02", by: "demo" },
    { id: "demo-3", type: "audio", audio: "", title: "voice note", date: "2024-06-14", caption: "a silent placeholder note", by: "demo", duration: 12 },
    { id: "demo-4", type: "photo", src: swatch("#6fd3ff", "#b48bff"), date: "2022-12-25", caption: "winter", by: "demo", song: { title: "Pink + White", artist: "Frank Ocean" } },
    { id: "demo-5", type: "photo", src: swatch("#9fe8c8", "#ff8a1f"), date: "2021-07-04", caption: "", by: "", song: null },
  ].map((d) => ({ clip: "", audio: "", text: "", title: "", caption: "", by: "", song: null, cover: "", src: "", ...d }));
}

// newest first, then file-numbered
export function sortAndNumber(items) {
  items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  items.forEach((it, i) => { it.dsc = dscName(i); it.index = i; });
  return items;
}

export async function loadArchive({ demo = false, fetchImpl = fetch } = {}) {
  const items = [];
  try {
    const list = await fetchImpl("photos.json", { cache: "no-cache" }).then((r) => r.json());
    if (Array.isArray(list)) items.push(...fromPhotosJson(list));
  } catch {}
  const gb = window.KimayaGuestbook;
  if (gb) {
    try {
      const posts = await gb.list();
      items.push(...fromGuestbook(posts, gb));
    } catch {}
  }
  if (demo) items.push(...demoItems());
  return sortAndNumber(items);
}

// paragraphs for the letter view: blank-line separated, single newlines kept as breaks
export function letterParagraphs(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}
