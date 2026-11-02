// kimaya.ink guestbook: visitors post a selfie + short note, nothing shows until approved.
//
// POST   /api/posts                  multipart: name, message, photo (jpeg), token (turnstile),
//                                    optional taken_on (YYYY-MM-DD), optional clip (webm/mp4)
// GET    /api/posts                  approved posts, by taken_on (fallback created_at), newest first
// GET    /api/photo/:id              jpeg, approved only
// GET    /api/admin/pending          Bearer ADMIN_TOKEN
// GET    /api/admin/photo/:id        Bearer ADMIN_TOKEN, any status
// POST   /api/admin/posts            Bearer ADMIN_TOKEN, same fields minus token, live at once
// POST   /api/admin/posts/:id/approve
// DELETE /api/admin/posts/:id

const MAX_PHOTO = 200 * 1024;
const MAX_CLIP = 800 * 1024;
const MAX_BODY = MAX_PHOTO + MAX_CLIP + 8 * 1024;
const MAX_NAME = 24;
const MAX_MESSAGE = 140;
const PER_IP_PER_HOUR = 3;
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

  if (parts[1] === "admin") {
    if (!isAdmin(req, env)) return json({ error: "unauthorized" }, 401);
    if (parts[2] === "pending" && req.method === "GET") return listPending(env);
    if (parts[2] === "photo" && parts[3] && req.method === "GET") return photo(env, parts[3], true);
    if (parts[2] === "posts" && !parts[3] && req.method === "POST") return createAdminPost(req, env);
    if (parts[2] === "posts" && parts[3]) {
      if (parts[4] === "approve" && req.method === "POST") return setStatus(env, parts[3], "approved");
      if (!parts[4] && req.method === "DELETE") return remove(env, parts[3]);
    }
  }

  return json({ error: "not found" }, 404);
}

// ---------- public ----------

// sorted as a series: when it was taken, else when it was posted
async function listApproved(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, message, taken_on, created_at FROM posts WHERE status = 'approved'
     ORDER BY COALESCE(taken_on, strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')) DESC, created_at DESC
     LIMIT ${WALL_LIMIT}`
  ).all();
  return json({ posts: results }, 200, { "Cache-Control": "public, max-age=30" });
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

async function createPost(req, env) {
  const { form, error } = await readForm(req);
  if (error) return error;

  const ip = req.headers.get("CF-Connecting-IP") || "unknown";

  if (!(await turnstileOk(env, form.get("token"), ip))) {
    return json({ error: "verification failed" }, 403);
  }

  const fields = await readFields(form, true);
  if (fields.error) return fields.error;

  const ipHash = await sha256(`${env.IP_SALT || ""}:${ip}`);
  const since = Date.now() - HOUR;

  const [{ n: mine }, { n: pending }] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE ip_hash = ? AND created_at > ?").bind(ipHash, since).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'pending'").first(),
  ]);
  if (mine >= PER_IP_PER_HOUR) return json({ error: "slow down, try again later" }, 429);
  if (pending >= MAX_PENDING) return json({ error: "guestbook is full right now" }, 503);

  await insertPost(env, fields, ipHash, "pending");
  return json({ ok: true, status: "pending" }, 201);
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

// shared by the public booth and the owner's bulk upload
async function readFields(form, textRequired) {
  const name = clean(form.get("name"), MAX_NAME);
  const message = clean(form.get("message"), MAX_MESSAGE);
  if (textRequired && (!name || !message)) return { error: json({ error: "name and message required" }, 400) };

  const raw = form.get("taken_on");
  const takenOn = raw === null || raw === "" ? null : validDay(raw);
  if (takenOn === false) return { error: json({ error: "taken_on must be a real YYYY-MM-DD date" }, 400) };

  const file = form.get("photo");
  if (!file || typeof file === "string") return { error: json({ error: "photo required" }, 400) };
  if (file.size > MAX_PHOTO) return { error: json({ error: "photo too big" }, 413) };
  const photo = new Uint8Array(await file.arrayBuffer());
  if (photo[0] !== 0xff || photo[1] !== 0xd8) return { error: json({ error: "photo must be jpeg" }, 415) };

  const clip = await readClip(form);
  if (clip.error) return clip;

  return { name, message, photo, takenOn, clip: clip.bytes, clipType: clip.type };
}

// optional movie clip: webm (ebml magic) or mp4 (ftyp box), 800KB max
async function readClip(form) {
  const file = form.get("clip");
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

async function insertPost(env, f, ipHash, status) {
  const row = {
    id: crypto.randomUUID(),
    name: f.name,
    message: f.message,
    photo: f.photo,
    ip_hash: ipHash,
    status,
    created_at: Date.now(),
    taken_on: f.takenOn,
  };
  // clip columns come from migrations/0002_clips.sql
  if (f.clip) Object.assign(row, { clip: f.clip, clip_type: f.clipType });
  const cols = Object.keys(row);
  await env.DB.prepare(`INSERT INTO posts (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...Object.values(row))
    .run();
  return row.id;
}

// ---------- admin ----------

// owner upload: isAdmin already passed, so no turnstile, no ip limit, straight to approved
async function createAdminPost(req, env) {
  const { form, error } = await readForm(req);
  if (error) return error;
  const fields = await readFields(form, false);
  if (fields.error) return fields.error;
  const id = await insertPost(env, fields, "admin", "approved");
  return json({ ok: true, id, status: "approved" }, 201);
}

async function listPending(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, message, taken_on, created_at FROM posts WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100"
  ).all();
  return json({ posts: results }, 200, { "Cache-Control": "no-store" });
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
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
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
