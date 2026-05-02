/**
 * Layer 1 — query handler.
 *
 * Receives a question, loads substrate, calls Claude API, returns the answer.
 * Also records the query/answer pair to memory (Layer 2).
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";
import { buildSubstrateContext } from "./github";
import { buildRecentQueriesContext, fetchRecentQueries, recordQuery } from "./memory";
import { BRAIN_SYSTEM_PROMPT, buildUserPrompt } from "./prompts";

interface QueryRequest {
  question: string;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";

export const handleQuery = async (
  request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const body = (await request.json()) as QueryRequest;
  if (!body.question || body.question.trim().length === 0) {
    return new Response(JSON.stringify({ error: "question is required" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }
  if (body.question.length > 4000) {
    return new Response(
      JSON.stringify({ error: "question too long (4000 char max)" }),
      { status: 400, headers: { "content-type": "application/json", ...cors } }
    );
  }

  const [substrate, recentQueries] = await Promise.all([
    buildSubstrateContext(ctx.env),
    buildRecentQueriesContext(ctx.env, 10),
  ]);

  const userPrompt = buildUserPrompt(body.question, substrate, recentQueries);

  const apiResp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ctx.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: BRAIN_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!apiResp.ok) {
    const errBody = await apiResp.text();
    console.error("anthropic api error", apiResp.status, errBody);
    return new Response(
      JSON.stringify({ error: `claude api ${apiResp.status}` }),
      { status: 502, headers: { "content-type": "application/json", ...cors } }
    );
  }

  const claudeResp = (await apiResp.json()) as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  const answer = claudeResp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

  // Fire-and-forget memory record — don't block response on KV write.
  // We do await it here for simplicity; for higher-volume usage move to ctx.waitUntil.
  await recordQuery(ctx.env, ctx.user, body.question, answer);

  return new Response(
    JSON.stringify({
      answer,
      usage: claudeResp.usage,
      asked_by: ctx.user.email,
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};

export const handleHistory = async (
  request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const url = new URL(request.url);
  const limit = Math.min(50, Number(url.searchParams.get("limit")) || 20);
  const records = await fetchRecentQueries(ctx.env, limit);
  return new Response(
    JSON.stringify({
      queries: records.map((r) => ({
        id: r.id,
        question: r.question,
        answer: r.answer,
        user: r.user,
        ts: r.ts,
      })),
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};
