// Minimal zero-dependency backend for the Tavus avatar web demo.
//
// Holds the Tavus API key (server-side only) and creates/ends conversations on
// behalf of the frontend. Reads configuration from the project-root .env.
//
// Run standalone:  npm run dev   (in this folder)
// Or it is started automatically by the frontend's `npm run dev` (in the parent, avatar/).

import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

// --- load the project-root .env (no dependency on Node's --env-file) ---
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", "..", ".env"); // project-root .env (avatar/backend -> avatar -> root), shared with Phase 1
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

const API = "https://tavusapi.com/v2";
const KEY = process.env.TAVUS_API_KEY;
const PERSONA_ID = process.env.TAVUS_PERSONA_ID;
const REPLICA_ID = process.env.TAVUS_REPLICA_ID || "r2c3392fa1fc";
const PORT = Number(process.env.PORT || process.env.BACKEND_PORT || 8787);
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");

// In production (Fly.io / Docker) the built frontend in ../dist is served from here too,
// so the whole app is one origin and one process. In dev, Vite serves the frontend.
const DIST = join(here, "..", "dist");
const SERVE_STATIC = existsSync(join(DIST, "index.html"));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveStatic(req, res) {
  const path = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // SPA fallback
  const ext = extname(file);
  const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache });
  res.end(readFileSync(file));
  return true;
}
const MAX_MINUTES = Number(process.env.DEMO_MAX_MINUTES || 3);

// --- access-code authentication ---
// Set ACCESS_CODE (a shared password) to require a login before a session can start. When it is
// unset (typical for local dev) the app is open. Sessions are an HMAC-signed, HttpOnly cookie;
// the signing secret is derived from the code, so changing the code signs everyone out.
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const AUTH_REQUIRED = ACCESS_CODE.length > 0;
const SESSION_SECRET = process.env.SESSION_SECRET || createHmac("sha256", "avatar-session").update(ACCESS_CODE).digest("hex");
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = "avatar_session";

const sign = (exp) => createHmac("sha256", SESSION_SECRET).update(String(exp)).digest("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!AUTH_REQUIRED) return true;
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const [exp, mac] = token.split(".");
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  return safeEqual(sign(exp), mac);
}

function sessionCookie(req, clear = false) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  if (clear) return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

// Simple per-IP throttle on login attempts: 10 tries per 15 minutes.
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  a.count += 1;
  return a.count > 10;
}
const clientIp = (req) => (req.headers["fly-client-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function tavus(path, method = "POST", payload) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

// Best-effort: end any still-active conversation so a new one can start.
// The free tier allows only one concurrent conversation.
async function endActiveConversations() {
  try {
    const { body } = await tavus("/conversations?limit=100", "GET");
    for (const c of body.data || []) {
      if (c.status === "active") await tavus(`/conversations/${c.conversation_id}/end`, "POST");
    }
  } catch {
    // ignore - this is just cleanup
  }
}

// The replica's portrait (still + short looping clip) for the landing page. It rarely changes,
// so cache it rather than calling Tavus on every page load.
let replicaCache = { at: 0, body: null };
async function replicaInfo() {
  if (replicaCache.body && Date.now() - replicaCache.at < 10 * 60 * 1000) return replicaCache.body;
  const { status, body } = await tavus(`/replicas/${REPLICA_ID}`, "GET");
  if (status >= 300) return { image: "", video: "" };
  replicaCache = {
    at: Date.now(),
    body: { image: body.thumbnail_image_url || "", video: body.thumbnail_video_url || "" },
  };
  return replicaCache.body;
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});

    if (req.method === "GET" && req.url === "/api/health") {
      return send(res, 200, { ok: true, hasPersona: Boolean(PERSONA_ID), replica: REPLICA_ID, authRequired: AUTH_REQUIRED });
    }

    // --- auth routes ---
    if (req.method === "GET" && req.url === "/api/me") {
      return send(res, 200, { authRequired: AUTH_REQUIRED, authed: isAuthed(req) });
    }
    if (req.method === "POST" && req.url === "/api/login") {
      if (!AUTH_REQUIRED) return send(res, 200, { ok: true });
      if (throttled(clientIp(req))) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
      const { code } = await readJson(req);
      if (typeof code !== "string" || !safeEqual(code.trim(), ACCESS_CODE)) {
        return send(res, 401, { error: "Incorrect access code." });
      }
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req) });
    }
    if (req.method === "POST" && req.url === "/api/logout") {
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, true) });
    }

    // everything below under /api requires a session when ACCESS_CODE is set
    if (req.url.startsWith("/api/") && !isAuthed(req)) {
      return send(res, 401, { error: "Please sign in with the access code." });
    }

    if (req.method === "GET" && req.url === "/api/replica") {
      if (!KEY) return send(res, 200, { image: "", video: "" });
      return send(res, 200, await replicaInfo());
    }

    if (req.method === "POST" && req.url === "/api/conversations") {
      if (!KEY) {
        return send(res, 500, { error: "TAVUS_API_KEY is not set (check the .env in the project root)." });
      }
      if (!PERSONA_ID) {
        return send(res, 400, {
          error: "TAVUS_PERSONA_ID is not set. Run `uv run setup_demo.py` in the project root first to create your persona.",
        });
      }
      await endActiveConversations(); // free the concurrency slot from any prior session
      const { status, body } = await tavus("/conversations", "POST", {
        persona_id: PERSONA_ID,
        replica_id: REPLICA_ID,
        conversation_name: "Avatar web demo",
        properties: {
          max_call_duration: MAX_MINUTES * 60,
          participant_left_timeout: 30,
          enable_closed_captions: true,
          language: "english",
        },
      });
      if (status >= 300) return send(res, status, { error: "Tavus create failed", detail: body });
      return send(res, 200, {
        conversation_url: body.conversation_url,
        conversation_id: body.conversation_id,
        max_seconds: MAX_MINUTES * 60,
      });
    }

    const endMatch = req.url && req.url.match(/^\/api\/conversations\/([^/]+)\/end$/);
    if (req.method === "POST" && endMatch) {
      const { status } = await tavus(`/conversations/${endMatch[1]}/end`, "POST");
      return send(res, status < 300 ? 200 : status, { ended: status < 300 });
    }

    if (req.method === "GET" && SERVE_STATIC && !req.url.startsWith("/api/")) {
      if (serveStatic(req, res)) return;
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    const msg = String(e);
    const friendly = msg.includes("fetch failed")
      ? "Could not reach the Tavus API (network error). Please try again."
      : msg;
    send(res, 502, { error: friendly });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[backend] listening on http://${HOST}:${PORT}${SERVE_STATIC ? " (serving dist/)" : ""}`);
  if (!KEY) console.warn("[backend] WARNING: TAVUS_API_KEY is not set in the root .env");
  if (!PERSONA_ID) console.warn("[backend] WARNING: TAVUS_PERSONA_ID not set - run `uv run setup_demo.py` first");
  if (!AUTH_REQUIRED) console.warn("[backend] ACCESS_CODE not set - the app is open to anyone who can reach it");
});
