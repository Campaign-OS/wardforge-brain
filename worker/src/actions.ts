/**
 * Layer 3 — action-taking.
 *
 * Pattern: propose, then confirm. Two-step always.
 *
 * 1. POST /api/actions/inbox       { question } → returns proposed line + token
 * 2. POST /api/actions/inbox/confirm { token } → executes (commits to repo)
 *
 * The token is a short-lived KV entry that ties confirmation to a specific
 * proposal. This prevents replay attacks and accidental double-execution.
 *
 * To add new action types (draft an ADR, open a PR, etc.) follow the same
 * propose/confirm pattern. Keep the human-in-the-loop gate. Do NOT remove
 * the confirmation step until an action has been confirmed >50 times without
 * issue, and even then think hard.
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";
import { appendToInbox } from "./github";

interface InboxProposeRequest {
  intent: string; // free-form description of what to add
}

interface InboxConfirmRequest {
  token: string;
  edited?: string; // optional: user edits the proposed line before confirming
}

interface InboxProposal {
  line: string;
  user: SessionUser;
  proposedAt: number;
}

const PROPOSAL_TTL_SECONDS = 5 * 60; // 5 minutes

export const handleInboxPropose = async (
  request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const body = (await request.json()) as InboxProposeRequest;
  if (!body.intent || body.intent.trim().length === 0) {
    return new Response(JSON.stringify({ error: "intent is required" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  // For inbox, the "proposal" is just normalizing the line. Other action types
  // would call Claude here to draft something more elaborate (an ADR, an email).
  const line = body.intent.trim().replace(/\n+/g, " ").slice(0, 280);

  const token = crypto.randomUUID();
  const proposal: InboxProposal = {
    line,
    user: ctx.user,
    proposedAt: Date.now(),
  };
  await ctx.env.BRAIN_MEMORY.put(`proposal:${token}`, JSON.stringify(proposal), {
    expirationTtl: PROPOSAL_TTL_SECONDS,
  });

  return new Response(
    JSON.stringify({
      token,
      proposal: {
        action: "append-to-inbox",
        line,
        target_file: "docs/inbox.md",
      },
      expires_in: PROPOSAL_TTL_SECONDS,
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};

export const handleInboxConfirm = async (
  request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const body = (await request.json()) as InboxConfirmRequest;
  if (!body.token) {
    return new Response(JSON.stringify({ error: "token is required" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const stored = await ctx.env.BRAIN_MEMORY.get(`proposal:${body.token}`);
  if (!stored) {
    return new Response(
      JSON.stringify({ error: "proposal expired or not found" }),
      { status: 404, headers: { "content-type": "application/json", ...cors } }
    );
  }
  const proposal = JSON.parse(stored) as InboxProposal;

  // Only the user who proposed can confirm. Prevents one founder
  // accidentally executing the other's pending proposal.
  if (proposal.user.email !== ctx.user.email) {
    return new Response(
      JSON.stringify({ error: "proposal belongs to a different user" }),
      { status: 403, headers: { "content-type": "application/json", ...cors } }
    );
  }

  const lineToCommit = (body.edited?.trim() || proposal.line).slice(0, 280);
  const result = await appendToInbox(ctx.env, lineToCommit, ctx.user.name, ctx.user.email);

  // Clean up the proposal token
  await ctx.env.BRAIN_MEMORY.delete(`proposal:${body.token}`);

  return new Response(
    JSON.stringify({
      ok: true,
      committed: lineToCommit,
      commit_sha: result.commitSha,
      commit_url: `https://github.com/${ctx.env.GITHUB_REPO}/commit/${result.commitSha}`,
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};
