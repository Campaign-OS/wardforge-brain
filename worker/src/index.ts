/**
 * WardForge Brain — Cloudflare Worker entry point.
 *
 * Routes:
 *   GET  /healthz                       — liveness check, no auth
 *   GET  /session/login                    — start Google OAuth flow
 *   GET  /session/callback                 — OAuth callback, sets session cookie
 *   GET  /session/me                       — return current user or 401
 *   POST /session/logout                   — clear session
 *   POST /api/query                     — Layer 1+2: ask the brain
 *   GET  /api/history?limit=N           — Layer 2: recent queries
 *   POST /api/actions/inbox             — Layer 3: propose adding to inbox
 *   POST /api/actions/inbox/confirm     — Layer 3: confirm and execute
 *
 * Every /api/* and /session/me route requires a valid session for an
 * @ward-forge.com email.
 */

import { handleQuery, handleHistory } from "./brain";
import { handleInboxPropose, handleInboxConfirm } from "./actions";
import {
  handleLoginStart,
  handleLoginCallback,
  handleMe,
  handleLogout,
  requireSession,
} from "./auth";

export interface Env {
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  GITHUB_REPO: string;
  ALLOWED_DOMAIN: string;
  FRONTEND_ORIGIN: string;
  BRAIN_MEMORY: KVNamespace;
}

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

const cors = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-credentials": "true",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.FRONTEND_ORIGIN;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    try {
      // Public routes
      if (url.pathname === "/healthz") {
        return new Response("ok", { headers: cors(origin) });
      }
      if (url.pathname === "/session/login") {
        return handleLoginStart(request, env);
      }
      if (url.pathname === "/session/callback") {
        return handleLoginCallback(request, env);
      }

      // Authenticated routes
      const session = await requireSession(request, env);
      if (!session.ok) {
        return json({ error: "unauthorized" }, 401, cors(origin));
      }

      const ctx = { user: session.user, env };

      if (url.pathname === "/session/me") {
        return handleMe(ctx, cors(origin));
      }
      if (url.pathname === "/session/logout") {
        return handleLogout(cors(origin));
      }
      if (url.pathname === "/api/query" && request.method === "POST") {
        return handleQuery(request, ctx, cors(origin));
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        return handleHistory(request, ctx, cors(origin));
      }
      if (url.pathname === "/api/actions/inbox" && request.method === "POST") {
        return handleInboxPropose(request, ctx, cors(origin));
      }
      if (url.pathname === "/api/actions/inbox/confirm" && request.method === "POST") {
        return handleInboxConfirm(request, ctx, cors(origin));
      }

      return json({ error: "not found" }, 404, cors(origin));
    } catch (err) {
      console.error("worker error", err);
      const message = err instanceof Error ? err.message : "internal error";
      return json({ error: message }, 500, cors(origin));
    }
  },
};
