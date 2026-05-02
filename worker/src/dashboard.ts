/**
 * Dashboard data aggregation.
 *
 * Single endpoint that returns everything the dashboard needs in one call,
 * so the frontend doesn't have to make 6 parallel requests on every page
 * load. The aggregation runs in the worker where it has fast paths to KV
 * and GitHub.
 *
 * Shape: lots of independent panels (tasks, metrics, inbox, weekly state,
 * brain activity). The dashboard renders progressively from this payload.
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";
import { fetchAllCommitments, type Commitment } from "./commitments";
import { fetchFile, fetchRecentCommits } from "./github";
import { listRecentThreads } from "./threads";

interface DashboardPayload {
  signed_in_as: { email: string; name: string; owner_key: string };
  commitments: Commitment[];
  metrics: {
    open_count: number;
    in_progress_count: number;
    blocked_count: number;
    done_this_week: number;
    slipping_count: number; // open commitments past deadline
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
  inbox_preview: {
    today_count: number;
    raw_excerpt: string;
  };
  weekly_state_preview: {
    most_recent_path: string | null;
    most_recent_excerpt: string;
  };
}

const ownerKeyFromEmail = (email: string): string => {
  const local = email.split("@")[0].toLowerCase();
  // Map common variants — adjust if names differ
  if (local.startsWith("troy")) return "troy";
  if (local.startsWith("matt")) return "matthew";
  return local;
};

const daysBetween = (a: Date, b: Date): number =>
  Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));

const startOfWeekISO = (): string => {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const offset = day === 0 ? 6 : day - 1; // make Monday the start
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - offset);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString().slice(0, 10);
};

const computeMetrics = (
  commitments: Commitment[],
  commits: string[],
  daysSinceLastState: number | null
): DashboardPayload["metrics"] => {
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = startOfWeekISO();

  let open = 0;
  let inProgress = 0;
  let blocked = 0;
  let doneThisWeek = 0;
  let slipping = 0;

  for (const c of commitments) {
    switch (c.status) {
      case "open":
        open++;
        break;
      case "in-progress":
        inProgress++;
        break;
      case "blocked":
        blocked++;
        break;
      case "done":
        if (c.completed && c.completed >= weekStart) doneThisWeek++;
        break;
      case "dropped":
        break;
    }
    if (
      (c.status === "open" || c.status === "in-progress") &&
      c.deadline &&
      c.deadline < today
    ) {
      slipping++;
    }
  }

  return {
    open_count: open,
    in_progress_count: inProgress,
    blocked_count: blocked,
    done_this_week: doneThisWeek,
    slipping_count: slipping,
    commits_past_7_days: commits.length,
    days_since_last_state_file: daysSinceLastState,
  };
};

/**
 * Find the most recent file in docs/state matching the YYYY-MM-DD-*.md pattern.
 * Returns null if no state files exist yet.
 */
const findMostRecentStateFile = async (
  env: Env
): Promise<{ path: string; date: string } | null> => {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/docs/state`;
  const r = await fetch(url, {
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "wardforge-brain",
    },
  });
  if (!r.ok) return null;
  const items = (await r.json()) as Array<{ name: string; type: string; path: string }>;
  const stateFiles = items
    .filter((i) => i.type === "file" && /^\d{4}-\d{2}-\d{2}/.test(i.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
  if (stateFiles.length === 0) return null;
  const date = stateFiles[0].name.slice(0, 10);
  return { path: stateFiles[0].path, date };
};

export const handleDashboard = async (
  _request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const ownerKey = ownerKeyFromEmail(ctx.user.email);

  // Parallel fetches for speed
  const [commitments, recentCommits, recentThreads, inboxRaw, mostRecentState] =
    await Promise.all([
      fetchAllCommitments(ctx.env),
      fetchRecentCommits(ctx.env, 7),
      listRecentThreads(ctx.env, 8),
      fetchFile(ctx.env, "docs/inbox/inbox.md").catch(() => "(inbox not loaded)"),
      findMostRecentStateFile(ctx.env),
    ]);

  // Inbox preview: count today's bullets, take first 600 chars as excerpt
  const today = new Date().toISOString().slice(0, 10);
  const todayHeading = `## ${today}`;
  let todayCount = 0;
  if (inboxRaw.includes(todayHeading)) {
    const idx = inboxRaw.indexOf(todayHeading);
    const next = inboxRaw.indexOf("\n## ", idx + todayHeading.length);
    const section =
      next === -1 ? inboxRaw.slice(idx) : inboxRaw.slice(idx, next);
    todayCount = (section.match(/^- /gm) || []).length;
  }
  const inboxExcerpt = inboxRaw.slice(0, 600);

  // Weekly state preview
  let stateExcerpt = "(no state files found)";
  let stateDays: number | null = null;
  if (mostRecentState) {
    const stateContent = await fetchFile(ctx.env, mostRecentState.path).catch(() => "");
    stateExcerpt = stateContent.slice(0, 800);
    const stateDate = new Date(mostRecentState.date + "T00:00:00Z");
    stateDays = daysBetween(new Date(), stateDate);
  }

  const metrics = computeMetrics(commitments, recentCommits, stateDays);

  const payload: DashboardPayload = {
    signed_in_as: {
      email: ctx.user.email,
      name: ctx.user.name,
      owner_key: ownerKey,
    },
    commitments,
    metrics,
    recent_commits: recentCommits,
    recent_threads: recentThreads.map((t) => ({
      id: t.id,
      title: t.title,
      created_by_name: t.created_by.name,
      updated_at: t.updated_at,
    })),
    inbox_preview: {
      today_count: todayCount,
      raw_excerpt: inboxExcerpt,
    },
    weekly_state_preview: {
      most_recent_path: mostRecentState?.path ?? null,
      most_recent_excerpt: stateExcerpt,
    },
  };

  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json", ...cors },
  });
};
