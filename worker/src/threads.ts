/**
 * Thread + turn persistence for multi-turn conversations.
 *
 * Replaces the old per-query memory model. Each conversation is a thread
 * containing an ordered list of turns. Thread metadata is stored separately
 * from turns so that listing threads doesn't require loading every message.
 *
 * KV key shape:
 *   thread:<thread_id>                            → Thread metadata JSON
 *   turn:<thread_id>:<padded_ts>:<turn_id>        → Turn JSON
 *
 * Padding the timestamp ensures lex-sort matches numeric-sort within a
 * thread's turn list.
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";

export interface Thread {
  id: string;
  title: string;
  created_by: SessionUser;
  created_at: number;
  updated_at: number;
}

export interface Turn {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  ts: number;
}

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

// Soft cap on how many turns from the thread tail are sent to Claude as
// conversation history. Older turns are dropped to keep context bounded.
// At 4-8K tokens per turn worst case, 20 turns = comfortable in 200K context.
const MAX_TURNS_IN_CONTEXT = 20;

const padTs = (ts: number): string => String(ts).padStart(15, "0");

const threadKey = (id: string): string => `thread:${id}`;
const turnKeyPrefix = (threadId: string): string => `turn:${threadId}:`;
const turnKey = (threadId: string, ts: number, turnId: string): string =>
  `${turnKeyPrefix(threadId)}${padTs(ts)}:${turnId}`;

/** Derive a usable thread title from the first user question. */
const deriveTitle = (firstQuestion: string): string => {
  const trimmed = firstQuestion.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Untitled";
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "…" : trimmed;
};

export const createThread = async (
  env: Env,
  user: SessionUser,
  firstQuestion: string
): Promise<Thread> => {
  const id = crypto.randomUUID();
  const now = Date.now();
  const thread: Thread = {
    id,
    title: deriveTitle(firstQuestion),
    created_by: user,
    created_at: now,
    updated_at: now,
  };
  await env.BRAIN_MEMORY.put(threadKey(id), JSON.stringify(thread), {
    expirationTtl: RETENTION_SECONDS,
  });
  return thread;
};

export const fetchThread = async (env: Env, id: string): Promise<Thread | null> => {
  const v = await env.BRAIN_MEMORY.get(threadKey(id));
  if (!v) return null;
  try {
    return JSON.parse(v) as Thread;
  } catch {
    return null;
  }
};

const updateThreadTimestamp = async (env: Env, id: string, ts: number): Promise<void> => {
  const thread = await fetchThread(env, id);
  if (!thread) return;
  thread.updated_at = ts;
  await env.BRAIN_MEMORY.put(threadKey(id), JSON.stringify(thread), {
    expirationTtl: RETENTION_SECONDS,
  });
};

export const appendTurn = async (
  env: Env,
  threadId: string,
  role: "user" | "assistant",
  content: string
): Promise<Turn> => {
  const id = crypto.randomUUID();
  const ts = Date.now();
  const turn: Turn = { id, thread_id: threadId, role, content, ts };
  await env.BRAIN_MEMORY.put(turnKey(threadId, ts, id), JSON.stringify(turn), {
    expirationTtl: RETENTION_SECONDS,
  });
  await updateThreadTimestamp(env, threadId, ts);
  return turn;
};

export const fetchTurns = async (env: Env, threadId: string): Promise<Turn[]> => {
  const list = await env.BRAIN_MEMORY.list({
    prefix: turnKeyPrefix(threadId),
    limit: 1000,
  });
  // KV list returns keys lexicographically; padded timestamp = chronological.
  const turns: Turn[] = [];
  for (const k of list.keys) {
    const v = await env.BRAIN_MEMORY.get(k.name);
    if (!v) continue;
    try {
      turns.push(JSON.parse(v) as Turn);
    } catch {
      /* skip corrupt records */
    }
  }
  return turns;
};

export const listRecentThreads = async (env: Env, limit = 30): Promise<Thread[]> => {
  // Listing all thread keys; metadata is small, ~200 bytes each.
  const list = await env.BRAIN_MEMORY.list({ prefix: "thread:", limit: 1000 });
  const threads: Thread[] = [];
  for (const k of list.keys) {
    const v = await env.BRAIN_MEMORY.get(k.name);
    if (!v) continue;
    try {
      threads.push(JSON.parse(v) as Thread);
    } catch {
      /* skip corrupt */
    }
  }
  threads.sort((a, b) => b.updated_at - a.updated_at);
  return threads.slice(0, limit);
};

/**
 * Build the messages array for the Anthropic API from a thread's turns.
 * Caps at MAX_TURNS_IN_CONTEXT — older turns are dropped to keep context
 * bounded. The current question is NOT included; the caller appends it as
 * the final user message with substrate attached.
 */
export const buildMessageHistory = (
  turns: Turn[]
): Array<{ role: "user" | "assistant"; content: string }> => {
  const capped = turns.slice(-MAX_TURNS_IN_CONTEXT);
  return capped.map((t) => ({ role: t.role, content: t.content }));
};

/**
 * Build a compact "recent threads" context string. The brain sees this
 * alongside substrate so it has signal about what's currently on people's
 * minds across the org. Lists thread title + author + last-updated date.
 */
export const buildRecentThreadsContext = async (
  env: Env,
  limit = 10
): Promise<string> => {
  const recent = await listRecentThreads(env, limit);
  if (recent.length === 0) return "";
  return recent
    .map((t) => {
      const date = new Date(t.updated_at).toISOString().slice(0, 10);
      return `- ${date} (${t.created_by.name}): ${t.title}`;
    })
    .join("\n");
};
