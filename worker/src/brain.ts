/**
 * Layer 1 — query handler.
 *
 * Receives a question, loads substrate (foundational files + TOC), calls
 * Claude API with the fetch_file tool, executes any tool calls until the
 * model produces a final answer, returns the answer. Also records the
 * query/answer pair to memory (Layer 2).
 *
 * The fetch_file tool lets the model pull specific files from the repo on
 * demand. The TOC in the substrate tells it what's available; the model
 * decides what to fetch based on the question.
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";
import { buildSubstrateContext, fetchFileForBrain } from "./github";
import { buildRecentQueriesContext, fetchRecentQueries, recordQuery } from "./memory";
import { BRAIN_SYSTEM_PROMPT, buildUserPrompt } from "./prompts";

interface QueryRequest {
  question: string;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-7";

// Cap the number of tool-use rounds. Each round = one model call + one tool
// execution. 6 rounds is plenty for any realistic query and prevents runaway
// costs if the model gets confused.
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

// Anthropic content blocks come in several shapes; type just enough to navigate.
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

  const [substrate, recentQueries] = await Promise.all([
    buildSubstrateContext(ctx.env),
    buildRecentQueriesContext(ctx.env, 10),
  ]);

  const userPrompt = buildUserPrompt(body.question, substrate, recentQueries);

  // Conversation messages — accumulates across tool-use rounds.
  const messages: Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }> = [
    { role: "user", content: userPrompt },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalAnswer = "";
  const filesFetched: string[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await callClaude(ctx.env, messages);
      totalInputTokens += resp.usage?.input_tokens ?? 0;
      totalOutputTokens += resp.usage?.output_tokens ?? 0;

      // Append the assistant's response (text + any tool_use blocks) to history.
      messages.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason !== "tool_use") {
        finalAnswer = resp.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        break;
      }

      // Model wants to call tools. Execute every tool_use block in parallel.
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
    return new Response(JSON.stringify({ error: msg }), {
      status: 502,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  if (!finalAnswer) {
    finalAnswer =
      "I hit the tool-call limit without finishing the answer. Try asking a more specific question.";
  }

  // Fire-and-forget memory record — don't block response on KV write.
  await recordQuery(ctx.env, ctx.user, body.question, finalAnswer);

  return new Response(
    JSON.stringify({
      answer: finalAnswer,
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      files_fetched: filesFetched,
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
