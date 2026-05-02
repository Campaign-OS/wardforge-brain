/**
 * Tiny API client. The Worker URL is set at build time via VITE_API_BASE.
 * Locally for dev: VITE_API_BASE=http://127.0.0.1:8787
 * In prod: VITE_API_BASE=https://brain-api.ward-forge.com
 *
 * Auth/session paths use /session/* (not /auth/*) — Cloudflare Free-tier
 * silently blocks /auth/* on browser GETs. See docs/deployment.md.
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

export interface ThreadSummary {
  id: string;
  title: string;
  created_by: User;
  created_at: number;
  updated_at: number;
}

export interface ThreadTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export type CommitmentStatus = "open" | "in-progress" | "blocked" | "done" | "dropped";
export type CommitmentHorizon = "today" | "this-week" | "later";

export interface Commitment {
  id: string;
  owner: string;
  title: string;
  created: string;
  deadline: string | null;
  horizon: CommitmentHorizon;
  status: CommitmentStatus;
  source: string;
  completed: string | null;
  notes: string;
}

/**
 * A staged proposal returned from the brain when it calls a propose tool.
 * The frontend renders these as confirm banners in the chat UI.
 */
export interface PendingProposal {
  token: string;
  kind: "commitment-create" | "commitment-update";
  description: string;
  preview: {
    new_commitment?: Partial<Commitment>;
    change?: { id: string; field: keyof Commitment; new_value: string | null };
  };
  source: "dashboard" | "brain";
  expires_in: number;
}

export interface DashboardData {
  signed_in_as: { email: string; name: string; owner_key: string };
  commitments: Commitment[];
  metrics: {
    open_count: number;
    in_progress_count: number;
    blocked_count: number;
    done_this_week: number;
    slipping_count: number;
    commits_past_7_days: number;
    days_since_last_state_file: number | null;
  };
  recent_commits: string[];
  recent_threads: Array<{
    id: string;
    title: string;
    created_by_name: string;
    updated_at: number;
  }>;
  inbox_preview: { today_count: number; raw_excerpt: string };
  weekly_state_preview: { most_recent_path: string | null; most_recent_excerpt: string };
}

export const api = {
  loginUrl: () => `${API_BASE}/session/login`,
  me: () => req<{ user: User }>("/session/me"),
  logout: () => req("/session/logout", { method: "POST" }),

  query: (question: string, thread_id?: string) =>
    req<{
      answer: string;
      thread_id: string;
      usage?: { input_tokens: number; output_tokens: number };
      files_fetched?: string[];
      pending_proposals?: PendingProposal[];
    }>("/api/query", {
      method: "POST",
      body: JSON.stringify(thread_id ? { question, thread_id } : { question }),
    }),

  threads: {
    list: (limit = 30) =>
      req<{ threads: ThreadSummary[] }>(`/api/threads?limit=${limit}`),
    get: (id: string) =>
      req<{ thread: ThreadSummary; turns: ThreadTurn[] }>(`/api/threads/${id}`),
  },

  dashboard: () => req<DashboardData>("/api/dashboard"),

  commitments: {
    list: () =>
      req<{ commitments: Commitment[]; signed_in_as: string }>("/api/commitments"),
    propose: (
      payload:
        | { new_commitment: Partial<Commitment> }
        | { change: { id: string; field: keyof Commitment; new_value: string | null } }
    ) =>
      req<{ token: string; kind: "create" | "update"; preview: unknown; expires_in: number }>(
        "/api/commitments/propose",
        { method: "POST", body: JSON.stringify(payload) }
      ),
    confirm: (token: string) =>
      req<{ ok: boolean; commit_sha: string; commit_url: string }>(
        "/api/commitments/confirm",
        { method: "POST", body: JSON.stringify({ token }) }
      ),
  },

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
