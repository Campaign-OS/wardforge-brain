/**
 * Tiny API client. The Worker URL is set at build time via VITE_API_BASE.
 * Locally for dev: VITE_API_BASE=http://127.0.0.1:8787
 * In prod: VITE_API_BASE=https://brain-api.ward-forge.com
 */

const API_BASE = import.meta.env.VITE_API_BASE || "https://brain-api.ward-forge.com";

const req = async <T>(
  path: string,
  init: RequestInit = {}
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> => {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const body = (await r.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    return { ok: false, status: r.status, error: msg };
  }
  return { ok: true, data: (await r.json()) as T };
};

export interface User {
  email: string;
  name: string;
}

export const api = {
  loginUrl: () => `${API_BASE}/session/login`,
  me: () => req<{ user: User }>("/session/me"),
  logout: () => req("/session/logout", { method: "POST" }),
  query: (question: string) =>
    req<{ answer: string; usage?: { input_tokens: number; output_tokens: number } }>(
      "/api/query",
      { method: "POST", body: JSON.stringify({ question }) }
    ),
  history: (limit = 20) =>
    req<{
      queries: Array<{
        id: string;
        question: string;
        answer: string;
        user: User;
        ts: number;
      }>;
    }>(`/api/history?limit=${limit}`),
  proposeInbox: (intent: string) =>
    req<{
      token: string;
      proposal: { action: string; line: string; target_file: string };
      expires_in: number;
    }>("/api/actions/inbox", { method: "POST", body: JSON.stringify({ intent }) }),
  confirmInbox: (token: string, edited?: string) =>
    req<{
      ok: boolean;
      committed: string;
      commit_sha: string;
      commit_url: string;
    }>("/api/actions/inbox/confirm", {
      method: "POST",
      body: JSON.stringify({ token, edited }),
    }),
};
