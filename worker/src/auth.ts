/**
 * Google Workspace SSO for the brain.
 *
 * Only @ward-forge.com accounts can log in. Session is a signed cookie
 * containing { email, name, exp }. The cookie is HttpOnly, Secure, and
 * scoped to the brain-api domain so the frontend cookie reads as
 * SameSite=None (cross-site between brain.ward-forge.com and brain-api).
 */

import type { Env } from "./index";

const SESSION_COOKIE = "wf_brain_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionUser {
  email: string;
  name: string;
}

interface SessionPayload extends SessionUser {
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const norm = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const hmac = async (secret: string, data: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64url(sig);
};

const signSession = async (payload: SessionPayload, secret: string): Promise<string> => {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
};

const verifySession = async (
  token: string,
  secret: string
): Promise<SessionPayload | null> => {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = await hmac(secret, body);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlDecode(body))) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
};

const getCookie = (request: Request, name: string): string | null => {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
};

const setCookieHeader = (token: string): string =>
  `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;

const clearCookieHeader = (): string =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`;

export const requireSession = async (
  request: Request,
  env: Env
): Promise<{ ok: true; user: SessionUser } | { ok: false }> => {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return { ok: false };
  const payload = await verifySession(token, env.SESSION_SECRET);
  if (!payload) return { ok: false };
  return { ok: true, user: { email: payload.email, name: payload.name } };
};

/** Start the OAuth flow — redirect to Google. */
export const handleLoginStart = (request: Request, env: Env): Response => {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/session/callback`;
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    hd: env.ALLOWED_DOMAIN, // hint Google to show only Workspace accounts
    access_type: "online",
    prompt: "select_account",
    state,
  });
  // We're not validating state across roundtrip in this MVP — the domain check
  // on the userinfo response is the real gate. Add CSRF state validation when
  // the brain is exposed beyond two founders.
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
};

/** OAuth callback — exchange code for token, verify domain, set session cookie. */
export const handleLoginCallback = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return new Response("missing code", { status: 400 });

  const redirectUri = `${url.origin}/session/callback`;

  // Exchange code for access token
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    return new Response(`token exchange failed: ${await tokenResp.text()}`, { status: 500 });
  }
  const { access_token } = (await tokenResp.json()) as { access_token: string };

  // Fetch user info
  const userResp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) {
    return new Response("userinfo failed", { status: 500 });
  }
  const userInfo = (await userResp.json()) as {
    email: string;
    name: string;
    hd?: string;
    email_verified?: boolean;
  };

  // Domain gate — this is the real auth check.
  if (userInfo.hd !== env.ALLOWED_DOMAIN) {
    return new Response(
      `Access restricted to ${env.ALLOWED_DOMAIN} accounts. Got: ${userInfo.email}`,
      { status: 403 }
    );
  }

  const session: SessionPayload = {
    email: userInfo.email,
    name: userInfo.name,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const token = await signSession(session, env.SESSION_SECRET);

  // Redirect back to the frontend with cookie set
  return new Response(null, {
    status: 302,
    headers: {
      location: env.FRONTEND_ORIGIN,
      "set-cookie": setCookieHeader(token),
    },
  });
};

export const handleMe = (
  ctx: { user: SessionUser },
  extraHeaders: Record<string, string>
): Response =>
  new Response(JSON.stringify({ user: ctx.user }), {
    headers: { "content-type": "application/json", ...extraHeaders },
  });

export const handleLogout = (extraHeaders: Record<string, string>): Response =>
  new Response(JSON.stringify({ ok: true }), {
    headers: {
      "content-type": "application/json",
      "set-cookie": clearCookieHeader(),
      ...extraHeaders,
    },
  });
