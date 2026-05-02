/**
 * Layer 1 — query handler with multi-turn threads.
 *
 * Each query belongs to a thread. If the request omits thread_id, a new
 * thread is created from the first question. Subsequent turns reference
 * the same thread_id to continue the conversation.
 *
 * Substrate is loaded fresh on every turn and injected only into the latest
 * user message. Older turns in the conversation history don't carry substrate
 * — keeps context bounded and ensures the brain always sees current state.
 *
 * The fetch_file tool is available across turns; the model can pull files
 * mid-conversation as the topic shifts.
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";
import { buildSubstrateContext, fetchFileForBrain } from "./github";
import {
  appendTurn,
  buildMessageHistory,
  buildRecentThreadsContext,
  createThread,
  fetchThread,
  fetchTurns,
  listRecentThreads,
} from "./threads";
import { BRAIN_SYSTEM_PROMPT, buildUserPrompt } from "./prompts";

interface QueryRequest {
  question: string;
  thread_id?: string;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";
const MAX_TOOL_ROUNDS = 6;

const TOOLS = [
  {
    name: "fetch_file",
    description:
      "Fetch the full contents of a file from the substrate repo (docs or code). " +
      "Use this when the always-loaded substrate doesn't contain a file you need " +
      "to answer the question. The 'Full file index' section of the substrate " +
      "shows every available path, split into Docs and Code sections. Access is " +
      "restricted to allowlisted directories (docs/, src/, worker/, frontend/, " +
      "lib/, scripts/, tests/, test/, public/, plus root-level configs) and " +
      "extensions (.md, .ts, .tsx, .js, .jsx, .json, .toml, .yaml, .yml, .txt, " +
      ".css, .html, .sql). Hidden files, lockfiles, build artifacts, secrets, " +
      "and node_modules are not accessible.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path relative to the repo root. Example: 'docs/sessions/2026-04-15.md' " +
            "or 'src/lib/redirect.ts'. Must be a path that appears in the file index.",
        },
      },
      required: ["path"],
    },
  },
];

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface ClaudeResponse {
  content: ContentBlock[];
  stop_reason: string;
  usage?: { input_tokens: number; output_tokens: number };
}

const callClaude = async (
  env: Env,
  messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }>
): Promise<ClaudeResponse> => {
  const apiResp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: BRAIN_SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
  if (!apiResp.ok) {
    const errBody = await apiResp.text();
    throw new Error(`anthropic api ${apiResp.status}: ${errBody}`);
  }
  return (await apiResp.json()) as ClaudeResponse;
};

const executeToolCall = async (
  env: Env,
  block: Extract<ContentBlock, { type: "tool_use" }>
): Promise<Extract<ContentBlock, { type: "tool_result" }>> => {
  if (block.name !== "fetch_file") {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: `unknown tool: ${block.name}`,
      is_error: true,
    };
  }
  const path = String((block.input as { path?: unknown }).path ?? "");
  const result = await fetchFileForBrain(env, path);
  if (!result.ok) {
    return {
      type: "tool_result",
      tool_use_id: block.id,
      content: result.error,
      is_error: true,
    };
  }
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: `[BEGIN FILE CONTENT — path: ${path}]\n${result.content}\n[END FILE CONTENT]`,
  };
};

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

  // Resolve thread: use existing or create new.
  let threadId = body.thread_id;
  let priorTurns: Awaited<ReturnType<typeof fetchTurns>> = [];

  if (threadId) {
    const existing = await fetchThread(ctx.env, threadId);
    if (!existing) {
      return new Response(
        JSON.stringify({ error: `thread not found: ${threadId}` }),
        { status: 404, headers: { "content-type": "application/json", ...cors } }
      );
    }
    priorTurns = await fetchTurns(ctx.env, threadId);
  } else {
    const newThread = await createThread(ctx.env, ctx.user, body.question);
    threadId = newThread.id;
  }

  // Load substrate fresh for this turn.
  const [substrate, recentThreads] = await Promise.all([
    buildSubstrateContext(ctx.env),
    buildRecentThreadsContext(ctx.env, 10),
  ]);

  const userPromptContent = buildUserPrompt(body.question, substrate, recentThreads);

  // Build messages array: prior turns (just text) + current user message
  // (text + substrate).
  const messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }> = [
    ...buildMessageHistory(priorTurns),
    { role: "user", content: userPromptContent },
  ];

  // Persist the user turn now (using just the question, not the substrate-laden
  // prompt). Even if Claude errors out, the question is recorded.
  await appendTurn(ctx.env, threadId, "user", body.question);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalAnswer = "";
  const filesFetched: string[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await callClaude(ctx.env, messages);
      totalInputTokens += resp.usage?.input_tokens ?? 0;
      totalOutputTokens += resp.usage?.output_tokens ?? 0;

      messages.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason !== "tool_use") {
        finalAnswer = resp.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        break;
      }

      const toolUses = resp.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
      );
      const toolResults = await Promise.all(toolUses.map((t) => executeToolCall(ctx.env, t)));
      for (const t of toolUses) {
        const path = String((t.input as { path?: unknown }).path ?? "");
        if (path) filesFetched.push(path);
      }
      messages.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    console.error("brain query failed", err);
    const msg = err instanceof Error ? err.message : "internal error";
    return new Response(JSON.stringify({ error: msg, thread_id: threadId }), {
      status: 502,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  if (!finalAnswer) {
    finalAnswer =
      "I hit the tool-call limit without finishing the answer. Try asking a more specific question.";
  }

  // Persist the assistant turn.
  await appendTurn(ctx.env, threadId, "assistant", finalAnswer);

  return new Response(
    JSON.stringify({
      answer: finalAnswer,
      thread_id: threadId,
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      files_fetched: filesFetched,
      asked_by: ctx.user.email,
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};

export const handleListThreads = async (
  request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const url = new URL(request.url);
  const limit = Math.min(50, Number(url.searchParams.get("limit")) || 30);
  const threads = await listRecentThreads(ctx.env, limit);
  return new Response(
    JSON.stringify({
      threads: threads.map((t) => ({
        id: t.id,
        title: t.title,
        created_by: t.created_by,
        created_at: t.created_at,
        updated_at: t.updated_at,
      })),
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};

export const handleGetThread = async (
  threadId: string,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const thread = await fetchThread(ctx.env, threadId);
  if (!thread) {
    return new Response(JSON.stringify({ error: "thread not found" }), {
      status: 404,
      headers: { "content-type": "application/json", ...cors },
    });
  }
  const turns = await fetchTurns(ctx.env, threadId);
  return new Response(
    JSON.stringify({
      thread: {
        id: thread.id,
        title: thread.title,
        created_by: thread.created_by,
        created_at: thread.created_at,
        updated_at: thread.updated_at,
      },
      turns: turns.map((t) => ({
        id: t.id,
        role: t.role,
        content: t.content,
        ts: t.ts,
      })),
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};
