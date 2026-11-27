// Compound API: Google sign-in, sessions, per-user data sync, and the
// optional Claude fallback for food entries the app can't read on its own.
// Static files are served by the assets binding; only /api/* reaches this code.

import Anthropic from "@anthropic-ai/sdk";

const SESSION_COOKIE = "hl_session";
const SESSION_DAYS = 180;
const DATA_KEYS = new Set(["foodlog:v5"]);
const MAX_VALUE_BYTES = 1_900_000; // D1 rows top out around 2 MB
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: "server_error" }, 500);
    }
  },
};

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  // Every state-changing call must come from our own page.
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("Origin");
    if (origin !== url.origin) return json({ error: "bad_origin" }, 403);
  }

  if (pathname === "/api/config" && method === "GET") {
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || null });
  }

  if (pathname === "/api/auth/google" && method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.credential !== "string") return json({ error: "bad_request" }, 400);
    const claims = await verifyGoogleIdToken(body.credential, env.GOOGLE_CLIENT_ID);
    if (!claims) return json({ error: "invalid_token" }, 401);
    if (!isAllowed(claims.email, env.ALLOWED_EMAILS)) return json({ error: "not_invited" }, 403);
    return startSession(env, claims);
  }

  if (pathname === "/api/auth/dev" && method === "POST") {
    // Local testing only: needs DEV_LOGIN=1 in .dev.vars and a localhost URL.
    if (env.DEV_LOGIN !== "1" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
      return json({ error: "not_found" }, 404);
    }
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "dev@example.com");
    return startSession(env, { sub: "dev:" + email, email, name: "Dev" });
  }

  if (pathname === "/api/logout" && method === "POST") {
    const token = getCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  const user = await currentUser(request, env);
  if (!user) return json({ error: "signed_out" }, 401);

  if (pathname === "/api/ai/status" && method === "GET") {
    return json({ enabled: aiConfigured(env), dailyLimit: aiDailyLimit(env) });
  }

  if (pathname === "/api/ai" && method === "POST") {
    return estimateFood(request, env, user);
  }

  if (pathname === "/api/me" && method === "GET") {
    return json({ email: user.email, name: user.name });
  }

  if (pathname === "/api/data") {
    const key = url.searchParams.get("key") || "foodlog:v5";
    if (!DATA_KEYS.has(key)) return json({ error: "bad_key" }, 400);

    if (method === "GET" && url.searchParams.get("meta") === "1") {
      const row = await env.DB.prepare(
        "SELECT version, updated_at FROM user_data WHERE user_id = ? AND key = ?"
      ).bind(user.id, key).first();
      return json({ version: row?.version ?? 0, updatedAt: row?.updated_at ?? null });
    }

    if (method === "GET") {
      const row = await env.DB.prepare(
        "SELECT value, version, updated_at FROM user_data WHERE user_id = ? AND key = ?"
      ).bind(user.id, key).first();
      return json(row ? { value: row.value, version: row.version, updatedAt: row.updated_at } : { value: null, version: 0 });
    }

    if (method === "PUT") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body.value !== "string" || !Number.isInteger(body.baseVersion)) {
        return json({ error: "bad_request" }, 400);
      }
      if (new TextEncoder().encode(body.value).length > MAX_VALUE_BYTES) return json({ error: "too_large" }, 413);
      try { JSON.parse(body.value); } catch { return json({ error: "not_json" }, 400); }

      const now = Date.now();
      let result;
      if (body.baseVersion === 0) {
        result = await env.DB.prepare(
          "INSERT INTO user_data (user_id, key, value, version, updated_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT DO NOTHING"
        ).bind(user.id, key, body.value, now).run();
      } else {
        result = await env.DB.prepare(
          "UPDATE user_data SET value = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND key = ? AND version = ?"
        ).bind(body.value, now, user.id, key, body.baseVersion).run();
      }
      if (result.meta.changes === 1) return json({ version: body.baseVersion + 1, updatedAt: now });

      // Someone else (another device) saved first: hand back the newer copy.
      const row = await env.DB.prepare(
        "SELECT value, version, updated_at FROM user_data WHERE user_id = ? AND key = ?"
      ).bind(user.id, key).first();
      return json({ error: "conflict", value: row?.value ?? null, version: row?.version ?? 0, updatedAt: row?.updated_at }, 409);
    }
  }

  return json({ error: "not_found" }, 404);
}

// ---- Claude fallback for food entries ----
// The app parses most entries on the device (engine.js). Only a food it
// doesn't recognise comes here, and only when an ANTHROPIC_API_KEY secret is
// set. Without the secret this stays off and the app asks for cal/protein.

const AI_MODEL = "claude-haiku-5-5";
const AI_MAX_TOKENS = 800;
const AI_MAX_BODY_BYTES = 60_000;
const AI_PROMPT_PREFIX = "You are the logging engine for a food tracker.";

function aiConfigured(env) {
  return Boolean(env.ANTHROPIC_API_KEY) && env.AI_ENABLED !== "0";
}

function aiDailyLimit(env) {
  const n = Number(env.AI_DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

function aiError(status, message) {
  return json({ type: "error", error: { type: "estimate_error", message } }, status);
}

async function estimateFood(request, env, user) {
  if (!aiConfigured(env)) return aiError(503, "Estimates aren't switched on. Add cal/protein, like \"burrito 900/40\".");

  const raw = await request.text();
  if (raw.length > AI_MAX_BODY_BYTES) return aiError(413, "That entry is too long.");
  let body;
  try { body = JSON.parse(raw); } catch { return aiError(400, "Bad request."); }
  const { system, messages } = body || {};
  // Only the app's own food-logging prompt is accepted, with plain-text turns.
  if (typeof system !== "string" || !system.startsWith(AI_PROMPT_PREFIX) || system.length > 40_000) {
    return aiError(400, "Bad request.");
  }
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 16 ||
      !messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length <= 4000)) {
    return aiError(400, "Bad request.");
  }

  // Per-user daily cap so one account can't run up the bill.
  const limit = aiDailyLimit(env);
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS ai_usage (user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (user_id, day))"
  ).run();
  const row = await env.DB.prepare(
    "INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1 RETURNING count"
  ).bind(user.id, day).first();
  if (row.count > limit) {
    return aiError(429, `You've used today's ${limit} estimates. Add cal/protein for now, like "burrito 900/40". It resets at midnight UTC.`);
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20_000 });
  let message;
  try {
    message = await client.messages.create({
      model: env.AI_MODEL || AI_MODEL,
      max_tokens: AI_MAX_TOKENS,
      // A short JSON reply; thinking adds time without helping here.
      thinking: { type: "disabled" },
      system,
      messages,
    });
  } catch (err) {
    console.error("estimate failed", err?.status, err?.message);
    if (err instanceof Anthropic.RateLimitError) return aiError(429, "Estimates are busy right now. Try again in a minute, or add cal/protein.");
    if (err instanceof Anthropic.AuthenticationError) return aiError(503, "Estimates aren't set up correctly on the server.");
    if (err instanceof Anthropic.APIConnectionError) return aiError(502, "Couldn't reach the estimate service. Try again, or add cal/protein.");
    return aiError(502, "The estimate failed. Try again, or add cal/protein.");
  }

  if (message.stop_reason === "refusal") return aiError(422, "Couldn't estimate that one. Add cal/protein instead.");
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!text.trim()) return aiError(502, "The estimate came back empty. Try again, or add cal/protein.");
  // Same shape the app has always read: text blocks holding the JSON answer.
  return json({ content: [{ type: "text", text: capitalizeNames(text) }] }, 200, { "Cache-Control": "no-store" });
}

// Food names start with a capital letter, the same as typed entries.
function capitalizeNames(text) {
  try {
    const obj = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (Array.isArray(obj.add)) {
      for (const item of obj.add) {
        if (item && typeof item.name === "string") item.name = item.name.charAt(0).toUpperCase() + item.name.slice(1);
      }
    }
    return JSON.stringify(obj);
  } catch {
    return text;
  }
}

async function startSession(env, claims) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, last_login_at = excluded.last_login_at"
  ).bind(claims.sub, claims.email, claims.name || null, now, now).run();

  const token = randomToken();
  const maxAge = SESSION_DAYS * 86400;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), claims.sub, now, now + maxAge * 1000),
  ]);
  return json({ email: claims.email, name: claims.name || null }, 200, { "Set-Cookie": sessionCookie(token, maxAge) });
}

async function currentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256(token), Date.now()).first();
}

function isAllowed(email, allowList) {
  if (!allowList || !allowList.trim()) return true;
  const allowed = allowList.split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(email).toLowerCase());
}

// ---- Google ID token check (RS256, signed by Google) ----

let jwksCache = { keys: null, expires: 0 };

async function googleKeys() {
  if (jwksCache.keys && Date.now() < jwksCache.expires) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error("jwks fetch failed: " + res.status);
  const { keys } = await res.json();
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1] || 3600);
  jwksCache = { keys, expires: Date.now() + maxAge * 1000 };
  return keys;
}

async function verifyGoogleIdToken(token, clientId) {
  if (!clientId) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(b64urlToString(parts[0]));
    claims = JSON.parse(b64urlToString(parts[1]));
  } catch { return null; }
  if (header.alg !== "RS256" || !header.kid) return null;

  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.has(claims.iss)) return null;
  if (claims.aud !== clientId) return null;
  if (typeof claims.exp !== "number" || claims.exp < now - 60) return null;
  if (!claims.sub || !claims.email || claims.email_verified !== true) return null;
  return claims;
}

// ---- helpers ----

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function sessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}
