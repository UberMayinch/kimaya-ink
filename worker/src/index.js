// kimaya.ink guestbook: visitors post a selfie + short note, nothing shows until approved.
//
// POST   /api/posts                  multipart: name, message, photo (jpeg), token (turnstile),
//                                    optional taken_on (YYYY-MM-DD), optional clip (webm/mp4)
//                                    several at once: photo.0, clip.0, taken_on.0, message.0 … up to 12
//                                    (name and message are shared; a message.N replaces it for that one)
// GET    /api/posts                  approved posts, by taken_on (fallback created_at), newest first, with has_clip
// GET    /api/photo/:id              jpeg, approved only
// GET    /api/clip/:id               webm/mp4, approved only, supports Range
// GET    /api/admin/pending          Bearer ADMIN_TOKEN
// GET    /api/admin/photo/:id        Bearer ADMIN_TOKEN, any status
// GET    /api/admin/clip/:id         Bearer ADMIN_TOKEN, any status
// POST   /api/admin/posts            Bearer ADMIN_TOKEN, same fields minus token, live at once
// POST   /api/admin/posts/:id/approve
// POST   /api/admin/posts/:id/unapprove   back to the queue (hidden from the site)
// PATCH  /api/admin/posts/:id        json { name?, message?, taken_on?, song? } -> the updated fields
// DELETE /api/admin/posts/:id
//
// every post form may also carry song_title / song_artist / song_itunes (optional): the song that goes with it.
// song_itunes is apple's track id from the picker, so the site plays exactly that one; without it the site
// searches apple by the words. stored as json in the song column (migrations/0004_song.sql).

const MAX_PHOTO = 200 * 1024;
const MAX_CLIP = 800 * 1024;
const MAX_ITEMS = 12; // photos or clips in one post form
const MAX_BODY = MAX_ITEMS * (MAX_PHOTO + MAX_CLIP) + 16 * 1024;
const MAX_NAME = 24;
const MAX_MESSAGE = 140;
const MAX_SONG_TITLE = 80;
const MAX_SONG_ARTIST = 60;
const MAX_JSON = 8 * 1024;
const PER_IP_PER_HOUR = 30; // posts (photos or clips) per ip per hour: a couple of drops of 12, or a few selfies
const MAX_PENDING = 300;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WALL_LIMIT = 500;

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const res = await route(req, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (err) {
      console.error(err);
      return json({ error: "server error" }, 500, cors);
    }
  },
};

async function route(req, env) {
  const { pathname } = new URL(req.url);
  const parts = pathname.split("/").filter(Boolean); // ["api", ...]
  if (parts[0] !== "api") return json({ error: "not found" }, 404);

  if (parts[1] === "posts" && parts.length === 2) {
    if (req.method === "GET") return listApproved(env);
    if (req.method === "POST") return createPost(req, env);
  }

  if (parts[1] === "photo" && parts.length === 3 && req.method === "GET") {
    return photo(env, parts[2], false);
  }

  if (parts[1] === "clip" && parts.length === 3 && req.method === "GET") {
    return clip(req, env, parts[2], false);
  }

  if (parts[1] === "admin") {
    if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
    if (parts[2] === "pending" && req.method === "GET") return listPending(env);
    if (parts[2] === "photo" && parts[3] && req.method === "GET") return photo(env, parts[3], true);
    if (parts[2] === "clip" && parts[3] && req.method === "GET") return clip(req, env, parts[3], true);
    if (parts[2] === "posts" && !parts[3] && req.method === "POST") return createAdminPost(req, env);
    if (parts[2] === "posts" && parts[3]) {
      if (parts[4] === "approve" && req.method === "POST") return setStatus(env, parts[3], "approved");
      if (parts[4] === "unapprove" && req.method === "POST") return setStatus(env, parts[3], "pending");
      if (!parts[4] && req.method === "DELETE") return remove(env, parts[3]);
      if (!parts[4] && req.method === "PATCH") return updatePost(req, env, parts[3]);
    }
  }

  return json({ error: "not found" }, 404);
}

// ---------- public ----------

// sorted as a series: when it was taken, else when it was posted
async function listApproved(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, message, taken_on, created_at, song, clip IS NOT NULL AS has_clip FROM posts WHERE status = 'approved'
     ORDER BY COALESCE(taken_on, strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')) DESC, created_at DESC
     LIMIT ${WALL_LIMIT}`
  ).all();
  return json({ posts: results.map(withExtras) }, 200, { "Cache-Control": "public, max-age=30" });
}

async function photo(env, id, admin) {
  const row = await env.DB.prepare(
    admin ? "SELECT photo FROM posts WHERE id = ?" : "SELECT photo FROM posts WHERE id = ? AND status = 'approved'"
  )
    .bind(id)
    .first();
  if (!row) return json({ error: "not found" }, 404);
  return new Response(toBytes(row.photo), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": admin ? "no-store" : "public, max-age=86400",
    },
  });
}

// short looping movie clip. safari won't play video without Range support.
async function clip(req, env, id, admin) {
  const row = await env.DB.prepare(
    admin
      ? "SELECT clip, clip_type FROM posts WHERE id = ? AND clip IS NOT NULL"
      : "SELECT clip, clip_type FROM posts WHERE id = ? AND status = 'approved' AND clip IS NOT NULL"
  )
    .bind(id)
    .first();
  if (!row) return json({ error: "not found" }, 404);

  const bytes = toBytes(row.clip);
  const total = bytes.length;
  const headers = {
    "Content-Type": row.clip_type === "video/mp4" ? "video/mp4" : "video/webm",
    "Cache-Control": admin ? "no-store" : "public, max-age=86400",
    "Accept-Ranges": "bytes",
  };

  const range = req.headers.get("Range");
  if (!range) return new Response(bytes, { headers });

  const r = parseRange(range, total);
  if (!r) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` } });
  return new Response(bytes.slice(r.start, r.end + 1), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${r.start}-${r.end}/${total}` },
  });
}

async function createPost(req, env) {
  const { form, error } = await readForm(req);
  if (error) return error;

  const ip = req.headers.get("CF-Connecting-IP") || "unknown";

  if (!(await turnstileOk(env, form.get("token"), ip))) {
    return json({ error: "verification failed" }, 403);
  }

  const fields = await readFields(form, true);
  if (fields.error) return fields.error;
  const { items } = fields;

  const ipHash = await sha256(`${env.IP_SALT || ""}:${ip}`);
  const since = Date.now() - HOUR;

  const [{ n: mine }, { n: pending }] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE ip_hash = ? AND created_at > ?").bind(ipHash, since).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'pending'").first(),
  ]);
  if (mine + items.length > PER_IP_PER_HOUR) return json({ error: "slow down, try again later" }, 429);
  if (pending + items.length > MAX_PENDING) return json({ error: "guestbook is full right now" }, 503);

  await insertPosts(env, items, ipHash, "pending");
  return json({ ok: true, status: "pending", count: items.length }, 201);
}

async function readForm(req) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (!len || len > MAX_BODY) return { error: json({ error: "too big" }, 413) };
  try {
    return { form: await req.formData() };
  } catch {
    return { error: json({ error: "bad form" }, 400) };
  }
}

// shared by the public booth and the owner's bulk upload. one post: photo, clip, taken_on (+ a song).
// several at once: photo.0, clip.0, taken_on.0, message.0 … (no songs). -> { items: [{ name, message, photo, … }] }
async function readFields(form, textRequired) {
  const name = clean(form.get("name"), MAX_NAME);
  const message = clean(form.get("message"), MAX_MESSAGE);
  const song = readSong(form.get("song_title"), form.get("song_artist"), form.get("song_itunes"));

  const suffixes = [];
  if (form.has("photo")) suffixes.push("");
  else for (let i = 0; i < MAX_ITEMS && form.has(`photo.${i}`); i++) suffixes.push(`.${i}`);
  if (!suffixes.length) return { error: json({ error: "photo required" }, 400) };
  if (form.has(`photo.${MAX_ITEMS}`)) return { error: json({ error: `${MAX_ITEMS} at once is the most` }, 400) };

  const items = [];
  for (const s of suffixes) {
    const text = (s && clean(form.get(`message${s}`), MAX_MESSAGE)) || message;
    if (textRequired && (!name || !text)) return { error: json({ error: "name and message required" }, 400) };

    const raw = form.get(`taken_on${s}`);
    const takenOn = raw === null || raw === "" ? null : validDay(raw);
    if (takenOn === false) return { error: json({ error: "taken_on must be a real YYYY-MM-DD date" }, 400) };

    const file = form.get(`photo${s}`);
    if (!file || typeof file === "string") return { error: json({ error: "photo required" }, 400) };
    if (file.size > MAX_PHOTO) return { error: json({ error: "photo too big" }, 413) };
    const photo = new Uint8Array(await file.arrayBuffer());
    if (photo[0] !== 0xff || photo[1] !== 0xd8) return { error: json({ error: "photo must be jpeg" }, 415) };

    const clip = await readClip(form, `clip${s}`);
    if (clip.error) return clip;

    items.push({ name, message: text, photo, takenOn, clip: clip.bytes, clipType: clip.type, song: s ? null : song });
  }
  return { items };
}

// the song that goes with a post: {title, artist, itunesId?} or null. a title alone is enough to look up.
function readSong(title, artist, itunes) {
  const t = clean(title, MAX_SONG_TITLE);
  if (!t) return null;
  const song = { title: t, artist: clean(artist, MAX_SONG_ARTIST) };
  const id = Number(itunes);
  if (Number.isInteger(id) && id > 0) song.itunesId = id;
  return song;
}

function parseSong(v) {
  if (!v || typeof v !== "string") return null;
  try {
    const s = JSON.parse(v);
    return s && typeof s.title === "string" && s.title ? { title: s.title, artist: typeof s.artist === "string" ? s.artist : "", ...(s.itunesId ? { itunesId: s.itunesId } : {}) } : null;
  } catch {
    return null;
  }
}

// optional movie clip: webm (ebml magic) or mp4 (ftyp box), 800KB max
async function readClip(form, key = "clip") {
  const file = form.get(key);
  if (file === null || file === "") return {};
  if (typeof file === "string") return { error: json({ error: "clip must be a file" }, 400) };
  if (file.size > MAX_CLIP) return { error: json({ error: "clip too big" }, 413) };
  const b = new Uint8Array(await file.arrayBuffer());
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { bytes: b, type: "video/webm" };
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") return { bytes: b, type: "video/mp4" };
  return { error: json({ error: "clip must be webm or mp4" }, 415) };
}

// "YYYY-MM-DD" that is a real day between 1900 and tomorrow, else false
function validDay(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  if (isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return false;
  if (v < "1900-01-01" || t > Date.now() + DAY) return false;
  return v;
}

// all or nothing. the first picked gets the newest stamp, so a drop lists in the order it was chosen
async function insertPosts(env, items, ipHash, status) {
  const now = Date.now();
  const ids = [];
  const stmts = items.map((f, i) => {
    const row = {
      id: crypto.randomUUID(),
      name: f.name,
      message: f.message,
      photo: f.photo,
      ip_hash: ipHash,
      status,
      created_at: now - i,
      taken_on: f.takenOn,
    };
    // clip columns come from migrations/0002_clips.sql, song from 0004_song.sql
    if (f.clip) Object.assign(row, { clip: f.clip, clip_type: f.clipType });
    if (f.song) row.song = JSON.stringify(f.song);
    ids.push(row.id);
    const cols = Object.keys(row);
    return env.DB.prepare(`INSERT INTO posts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...Object.values(row));
  });
  await env.DB.batch(stmts);
  return ids;
}

// ---------- admin ----------

// owner upload: isAdmin already passed, so no turnstile, no ip limit, straight to approved
async function createAdminPost(req, env) {
  const { form, error } = await readForm(req);
  if (error) return error;
  const fields = await readFields(form, false);
  if (fields.error) return fields.error;
  const ids = await insertPosts(env, fields.items, "admin", "approved");
  return json({ ok: true, id: ids[0], ids, status: "approved", count: ids.length }, 201);
}

async function listPending(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, message, taken_on, created_at, song, clip IS NOT NULL AS has_clip FROM posts WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100"
  ).all();
  return json({ posts: results.map(withExtras) }, 200, { "Cache-Control": "no-store" });
}

// edit the words on a post. only the keys sent change; a song of null clears it.
async function updatePost(req, env, id) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > MAX_JSON) return json({ error: "too big" }, 413);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "bad json" }, 400);
  const set = {};
  if ("name" in body) set.name = clean(body.name, MAX_NAME);
  if ("message" in body) set.message = clean(body.message, MAX_MESSAGE);
  if ("taken_on" in body) {
    const v = body.taken_on === null || body.taken_on === "" ? null : validDay(body.taken_on);
    if (v === false) return json({ error: "taken_on must be a real YYYY-MM-DD date" }, 400);
    set.taken_on = v;
  }
  if ("song" in body) {
    const s = body.song;
    const song = s && typeof s === "object" ? readSong(s.title, s.artist, s.itunesId) : null;
    set.song = song ? JSON.stringify(song) : null;
  }
  const keys = Object.keys(set);
  if (!keys.length) return json({ error: "nothing to change" }, 400);
  const r = await env.DB.prepare(`UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => set[k]), id)
    .run();
  if (!r.meta.changes) return json({ error: "not found" }, 404);
  const row = await env.DB.prepare("SELECT id, name, message, taken_on, created_at, status, song, clip IS NOT NULL AS has_clip FROM posts WHERE id = ?").bind(id).first();
  return json({ ok: true, post: withExtras(row) });
}

async function setStatus(env, id, status) {
  const r = await env.DB.prepare("UPDATE posts SET status = ? WHERE id = ?").bind(status, id).run();
  return r.meta.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
}

async function remove(env, id) {
  const r = await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
  return r.meta.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
}

// fails closed: no token configured, or too short, means nobody is admin
function isAdmin(req, env) {
  const want = env.ADMIN_TOKEN;
  if (typeof want !== "string" || want.length < 24) return false;
  const got = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  return safeEqual(got, want);
}

// ---------- helpers ----------

// fails closed: no secret configured means every post is rejected
async function turnstileOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET || typeof token !== "string" || !token) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = await r.json().catch(() => ({}));
  return data.success === true;
}

function clean(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// "bytes=a-b", "bytes=a-", "bytes=-n" -> { start, end } inclusive, or null if unsatisfiable
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2]) || !total) return null;
  let start, end;
  if (!m[1]) {
    start = Math.max(0, total - Number(m[2]));
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  }
  if (start > end || start >= total) return null;
  return { start, end };
}

function withExtras(p) {
  return { ...p, has_clip: !!p.has_clip, song: parseSong(p.song) };
}

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(v); // D1 may hand back a plain number[]
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < y.length; i++) diff |= (x[i] || 0) ^ y[i];
  return diff === 0;
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!ok) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
