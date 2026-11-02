// kimaya.ink guestbook: visitors post a selfie + short note, nothing shows until approved.
//
// POST   /api/posts                  multipart: name, message, photo (jpeg), token (turnstile)
// GET    /api/posts                  approved posts, newest first
// GET    /api/photo/:id              jpeg, approved only
// GET    /api/admin/pending          Bearer ADMIN_TOKEN
// GET    /api/admin/photo/:id        Bearer ADMIN_TOKEN, any status
// POST   /api/admin/posts/:id/approve
// DELETE /api/admin/posts/:id

const MAX_PHOTO = 200 * 1024;
const MAX_BODY = MAX_PHOTO + 8 * 1024;
const MAX_NAME = 24;
const MAX_MESSAGE = 140;
const PER_IP_PER_HOUR = 3;
const MAX_PENDING = 300;
const HOUR = 60 * 60 * 1000;

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
    if (parts[2] === "posts" && parts[3]) {
      if (parts[4] === "approve" && req.method === "POST") return setStatus(env, parts[3], "approved");
      if (!parts[4] && req.method === "DELETE") return remove(env, parts[3]);
    }
  }

  return json({ error: "not found" }, 404);
}

// ---------- public ----------

async function listApproved(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, message, created_at FROM posts WHERE status = 'approved' ORDER BY created_at DESC LIMIT 60"
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
  const len = Number(req.headers.get("Content-Length") || 0);
  if (!len || len > MAX_BODY) return json({ error: "too big" }, 413);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "bad form" }, 400);
  }

  const ip = req.headers.get("CF-Connecting-IP") || "unknown";

  if (!(await turnstileOk(env, form.get("token"), ip))) {
    return json({ error: "verification failed" }, 403);
  }

  const name = clean(form.get("name"), MAX_NAME);
  const message = clean(form.get("message"), MAX_MESSAGE);
  if (!name || !message) return json({ error: "name and message required" }, 400);

  const file = form.get("photo");
  if (!file || typeof file === "string") return json({ error: "photo required" }, 400);
  if (file.size > MAX_PHOTO) return json({ error: "photo too big" }, 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return json({ error: "photo must be jpeg" }, 415);

  const ipHash = await sha256(`${env.IP_SALT || ""}:${ip}`);
  const since = Date.now() - HOUR;

  const [{ n: mine }, { n: pending }] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE ip_hash = ? AND created_at > ?").bind(ipHash, since).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE status = 'pending'").first(),
  ]);
  if (mine >= PER_IP_PER_HOUR) return json({ error: "slow down, try again later" }, 429);
  if (pending >= MAX_PENDING) return json({ error: "guestbook is full right now" }, 503);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO posts (id, name, message, photo, ip_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
  )
    .bind(id, name, message, bytes, ipHash, Date.now())
    .run();

  return json({ ok: true, status: "pending" }, 201);
}

// ---------- admin ----------

async function listPending(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, message, created_at FROM posts WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100"
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
