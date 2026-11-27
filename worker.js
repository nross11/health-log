// Compound API: Google sign-in, sessions, and per-user data sync.
// Static files are served by the assets binding; only /api/* reaches this code.

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
  if (!user) {
    if (pathname === "/api/ai") return aiError(401, "You're signed out. Reload the app to sign in again.");
    return json({ error: "signed_out" }, 401);
  }

  if (pathname === "/api/ai" && method === "POST") {
    return proxyAi(request, env, user);
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

// ---- AI proxy: the app's food/weight/steps parsing goes through here ----
// The Anthropic key lives only in the ANTHROPIC_API_KEY Worker secret.

const AI_MAX_BODY_BYTES = 8_000_000; // room for a photo
const AI_MAX_TOKENS = 2000;
const AI_ALLOWED_TOOLS = new Set(["web_search_20250305"]);

function aiError(status, message) {
  return json({ type: "error", error: { type: "proxy_error", message } }, status);
}

async function proxyAi(request, env, user) {
  if (!env.ANTHROPIC_API_KEY) return aiError(503, "AI isn't set up yet (no API key on the server).");

  const raw = await request.text();
  if (raw.length > AI_MAX_BODY_BYTES) return aiError(413, "That request is too large.");
  let body;
  try { body = JSON.parse(raw); } catch { return aiError(400, "Bad request."); }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 50) {
    return aiError(400, "Bad request.");
  }

  // Per-user daily limit so one account can't run up the bill.
  const limit = Number(env.AI_DAILY_LIMIT || 300);
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "INSERT INTO ai_usage (user_id, day, count) VALUES (?, ?, 1) " +
    "ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1 RETURNING count"
  ).bind(user.id, day).first();
  if (row.count > limit) return aiError(429, `Daily limit of ${limit} entries reached. It resets at midnight UTC.`);

  // Only forward the fields the app uses; the server picks the model.
  const upstream = {
    model: env.AI_MODEL || "claude-sonnet-5-5",
    max_tokens: Math.min(Number(body.max_tokens) || 1000, AI_MAX_TOKENS),
    messages: body.messages,
  };
  if (typeof body.system === "string") upstream.system = body.system;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.filter((t) => t && AI_ALLOWED_TOOLS.has(t.type)).map((t) => ({ ...t, max_uses: Math.min(t.max_uses || 3, 3) }));
    if (tools.length) upstream.tools = tools;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(upstream),
  });
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
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
