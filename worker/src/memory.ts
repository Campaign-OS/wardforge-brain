/**
 * Layer 2 — query memory.
 *
 * Every query/response pair is stored in KV. The KV store is the brain's
 * conversational memory across users and time. Layer 1 reads recent queries
 * from here to include as context when answering new questions.
 *
 * Design choices:
 * - Keys: `query:<timestamp>:<id>` — sortable by recency
 * - Values: JSON {question, answer, user, ts}
 * - Retention: 90 days (set via KV expiration)
 * - No PII filtering yet — assume only @ward-forge.com users have access.
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";

interface QueryRecord {
  id: string;
  question: string;
  answer: string;
  user: SessionUser;
  ts: number;
}

const RETENTION_SECONDS = 90 * 24 * 60 * 60;

export const recordQuery = async (
  env: Env,
  user: SessionUser,
  question: string,
  answer: string
): Promise<QueryRecord> => {
  const id = crypto.randomUUID();
  const ts = Date.now();
  const record: QueryRecord = { id, question, answer, user, ts };
  // Pad ts so lex sort matches numeric sort
  const key = `query:${String(ts).padStart(15, "0")}:${id}`;
  await env.BRAIN_MEMORY.put(key, JSON.stringify(record), {
    expirationTtl: RETENTION_SECONDS,
  });
  return record;
};

export const fetchRecentQueries = async (
  env: Env,
  limit = 10
): Promise<QueryRecord[]> => {
  // KV doesn't sort lex by default; we list with prefix and take the latest.
  // For ~10K queries (years of usage at our pace) this is fine.
  const list = await env.BRAIN_MEMORY.list({ prefix: "query:", limit: 1000 });
  const sorted = list.keys.sort((a, b) => (a.name < b.name ? 1 : -1)).slice(0, limit);

  const records: QueryRecord[] = [];
  for (const k of sorted) {
    const value = await env.BRAIN_MEMORY.get(k.name);
    if (value) {
      try {
        records.push(JSON.parse(value) as QueryRecord);
      } catch {
        /* skip corrupt records */
      }
    }
  }
  return records;
};

/**
 * Build a compact "recent queries" string for the prompt context.
 * Only includes the question, not the answer — keeps tokens down and
 * avoids the brain copying its own previous answers verbatim.
 */
export const buildRecentQueriesContext = async (env: Env, limit = 10): Promise<string> => {
  const recent = await fetchRecentQueries(env, limit);
  if (recent.length === 0) return "";
  return recent
    .map((r) => {
      const date = new Date(r.ts).toISOString().slice(0, 10);
      return `- ${date} (${r.user.name}): ${r.question}`;
    })
    .join("\n");
};
