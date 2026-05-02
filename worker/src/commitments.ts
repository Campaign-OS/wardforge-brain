/**
 * Commitments — the dashboard's source of truth for tracked work.
 *
 * Lives at docs/state/commitments.md in the substrate repo. Each commitment
 * is a YAML block separated by `---`. The file is canonical; this module
 * parses it for read APIs and rewrites it for write APIs.
 *
 * Architecture:
 * - Read path: parse the markdown into Commitment objects.
 * - Write path: regenerate the full file with all blocks, commit via GitHub
 *   contents API. One commit per change for clean audit history.
 * - Propose-confirm: every change goes through a 5min KV-stored proposal that
 *   the user (or only the user) can confirm. Same pattern as inbox actions.
 *
 * The brain calls into this module directly via the exposed `propose*`
 * helpers (no HTTP hop) when it wants to suggest a commitment change from
 * a chat conversation.
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";
import { fetchFile } from "./github";

const COMMITMENTS_PATH = "docs/state/commitments.md";
const GH_API = "https://api.github.com";
const PROPOSAL_TTL_SECONDS = 5 * 60;

const ghHeaders = (token: string): HeadersInit => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "wardforge-brain",
});

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

export const VALID_STATUSES: CommitmentStatus[] = [
  "open",
  "in-progress",
  "blocked",
  "done",
  "dropped",
];
export const VALID_HORIZONS: CommitmentHorizon[] = ["today", "this-week", "later"];

const parseBlock = (block: string): Commitment | null => {
  const lines = block.split("\n");
  const fields: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  if (!fields.id || !fields.title) return null;

  const status = (fields.status || "open") as CommitmentStatus;
  const horizon = (fields.horizon || "later") as CommitmentHorizon;

  return {
    id: fields.id,
    owner: fields.owner || "unknown",
    title: fields.title,
    created: fields.created || "",
    deadline: fields.deadline === "null" || !fields.deadline ? null : fields.deadline,
    horizon: VALID_HORIZONS.includes(horizon) ? horizon : "later",
    status: VALID_STATUSES.includes(status) ? status : "open",
    source: fields.source || "",
    completed: fields.completed === "null" || !fields.completed ? null : fields.completed,
    notes: fields.notes || "",
  };
};

const splitBlocks = (markdown: string): string[] => {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const sections = normalized.split(/\n---\n/);
  return sections.slice(1).filter((s) => s.trim().length > 0);
};

const formatBlock = (c: Commitment): string => {
  return [
    `id: ${c.id}`,
    `owner: ${c.owner}`,
    `title: ${c.title}`,
    `created: ${c.created}`,
    `deadline: ${c.deadline ?? "null"}`,
    `horizon: ${c.horizon}`,
    `status: ${c.status}`,
    `source: ${c.source}`,
    `completed: ${c.completed ?? "null"}`,
    `notes: ${c.notes}`,
  ].join("\n");
};

const HEADER = `# Commitments

Source of truth for active commitments at WardForge. Each commitment is a YAML block separated by \`---\`. The brain reads this for synthesis ("what's open?", "what's slipping?") and proposes additions/changes via the dashboard. Humans confirm.

## Schema

Each entry has:

- **id** — \`c-YYYY-MM-DD-NNN\`. Stable across renames; never reused.
- **owner** — \`troy\` or \`matthew\`. Lowercase, exact match.
- **title** — short imperative phrase. <80 chars.
- **created** — \`YYYY-MM-DD\` when the commitment was logged.
- **deadline** — \`YYYY-MM-DD\` if there's a hard date, otherwise \`null\`.
- **horizon** — \`today\` | \`this-week\` | \`later\`. Drives kanban column. Set explicitly; the brain can propose changes.
- **status** — \`open\` | \`in-progress\` | \`blocked\` | \`done\` | \`dropped\`.
- **source** — file path or short description of where this commitment came from. Helps trace why it exists.
- **completed** — \`YYYY-MM-DD\` when status moved to \`done\`. Null otherwise.
- **notes** — optional free-form context. <500 chars.

## Rules

- Brain proposes changes; humans confirm. Same propose-confirm pattern as inbox.
- Never delete entries — set status to \`dropped\` instead. History matters.
- If a commitment moves to \`done\` or \`dropped\`, leave it in this file for at least 30 days before archiving. The brain reads done items to detect patterns.
- The dashboard at \`brain.ward-forge.com/dashboard\` is the operational view of this file. The file is canonical.
`;

const formatFile = (commitments: Commitment[]): string => {
  const blocks = commitments.map(formatBlock).join("\n\n---\n\n");
  return `${HEADER}\n---\n\n${blocks}\n`;
};

const todayStr = (): string => new Date().toISOString().slice(0, 10);

export const fetchAllCommitments = async (env: Env): Promise<Commitment[]> => {
  const content = await fetchFile(env, COMMITMENTS_PATH);
  if (content.startsWith("(") && content.endsWith(" not found)")) return [];
  const blocks = splitBlocks(content);
  return blocks.map(parseBlock).filter((c): c is Commitment => c !== null);
};

const writeCommitments = async (
  env: Env,
  commitments: Commitment[],
  message: string,
  authorName: string,
  authorEmail: string
): Promise<{ commitSha: string }> => {
  const url = `${GH_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(
    COMMITMENTS_PATH
  )}`;

  const getResp = await fetch(url, { headers: ghHeaders(env.GITHUB_TOKEN) });
  let sha: string | undefined;
  if (getResp.ok) {
    const file = (await getResp.json()) as { sha: string };
    sha = file.sha;
  } else if (getResp.status !== 404) {
    throw new Error(`could not read commitments: ${getResp.status}`);
  }

  const updated = formatFile(commitments);
  const bytes = new TextEncoder().encode(updated);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const newContent = btoa(bin);

  const putBody: Record<string, unknown> = {
    message,
    content: newContent,
    committer: { name: "wardforge-brain", email: "[email protected]" },
    author: { name: authorName, email: authorEmail },
  };
  if (sha) putBody.sha = sha;

  const putResp = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(env.GITHUB_TOKEN), "content-type": "application/json" },
    body: JSON.stringify(putBody),
  });
  if (!putResp.ok) {
    throw new Error(`commitments write failed: ${putResp.status} ${await putResp.text()}`);
  }
  const result = (await putResp.json()) as { commit: { sha: string } };
  return { commitSha: result.commit.sha };
};

const generateId = async (env: Env): Promise<string> => {
  const today = todayStr();
  const all = await fetchAllCommitments(env);
  const todayPrefix = `c-${today}-`;
  const existingNumbers = all
    .filter((c) => c.id.startsWith(todayPrefix))
    .map((c) => parseInt(c.id.slice(todayPrefix.length), 10))
    .filter((n) => !isNaN(n));
  const next = existingNumbers.length === 0 ? 1 : Math.max(...existingNumbers) + 1;
  return `${todayPrefix}${String(next).padStart(3, "0")}`;
};

// ---- Proposal records (KV) ----

interface ProposalRecord {
  kind: "create" | "update";
  payload: {
    new_commitment?: Partial<Commitment>;
    change?: { id: string; field: keyof Commitment; new_value: string | null };
  };
  user: SessionUser;
  proposedAt: number;
  source: "dashboard" | "brain"; // who proposed it
}

export interface ProposalDescriptor {
  token: string;
  kind: "commitment-create" | "commitment-update";
  description: string;
  preview: ProposalRecord["payload"];
  source: "dashboard" | "brain";
  expires_in: number;
}

const buildDescription = async (
  env: Env,
  record: ProposalRecord
): Promise<string> => {
  if (record.kind === "create" && record.payload.new_commitment) {
    const nc = record.payload.new_commitment;
    return `Add commitment: "${nc.title || ""}" (${nc.owner || "unspecified"}, ${nc.horizon || "later"})`;
  }
  if (record.kind === "update" && record.payload.change) {
    const ch = record.payload.change;
    // Try to find the existing commitment for richer context
    const all = await fetchAllCommitments(env);
    const existing = all.find((c) => c.id === ch.id);
    const titleHint = existing ? ` (${existing.title})` : "";
    return `${ch.id}${titleHint}: ${ch.field} → ${ch.new_value ?? "null"}`;
  }
  return "Unknown change";
};

/**
 * Create a "create commitment" proposal. Returns the descriptor that the
 * frontend uses to render a confirm banner.
 *
 * Caller (HTTP handler or brain tool) is responsible for validating user
 * authentication. This function trusts the SessionUser passed in.
 */
export const proposeCreate = async (
  env: Env,
  user: SessionUser,
  draft: Partial<Commitment>,
  source: "dashboard" | "brain" = "dashboard"
): Promise<{ ok: true; descriptor: ProposalDescriptor } | { ok: false; error: string }> => {
  if (!draft.title || draft.title.trim().length === 0) {
    return { ok: false, error: "title is required for new commitments" };
  }
  if (draft.horizon && !VALID_HORIZONS.includes(draft.horizon)) {
    return { ok: false, error: `invalid horizon: ${draft.horizon}` };
  }
  if (draft.status && !VALID_STATUSES.includes(draft.status)) {
    return { ok: false, error: `invalid status: ${draft.status}` };
  }

  const token = crypto.randomUUID();
  const record: ProposalRecord = {
    kind: "create",
    payload: { new_commitment: draft },
    user,
    proposedAt: Date.now(),
    source,
  };
  await env.BRAIN_MEMORY.put(`commitment-proposal:${token}`, JSON.stringify(record), {
    expirationTtl: PROPOSAL_TTL_SECONDS,
  });

  return {
    ok: true,
    descriptor: {
      token,
      kind: "commitment-create",
      description: await buildDescription(env, record),
      preview: record.payload,
      source,
      expires_in: PROPOSAL_TTL_SECONDS,
    },
  };
};

/**
 * Create an "update commitment" proposal. Validates that the commitment
 * exists and the field is editable.
 */
export const proposeUpdate = async (
  env: Env,
  user: SessionUser,
  change: { id: string; field: keyof Commitment; new_value: string | null },
  source: "dashboard" | "brain" = "dashboard"
): Promise<{ ok: true; descriptor: ProposalDescriptor } | { ok: false; error: string }> => {
  if (!change.id || !change.field) {
    return { ok: false, error: "change must include id and field" };
  }

  // Verify the commitment exists
  const all = await fetchAllCommitments(env);
  if (!all.find((c) => c.id === change.id)) {
    return { ok: false, error: `commitment not found: ${change.id}` };
  }

  // Validate field-specific values
  if (change.field === "status") {
    if (!VALID_STATUSES.includes(change.new_value as CommitmentStatus)) {
      return { ok: false, error: `invalid status: ${change.new_value}` };
    }
  }
  if (change.field === "horizon") {
    if (!VALID_HORIZONS.includes(change.new_value as CommitmentHorizon)) {
      return { ok: false, error: `invalid horizon: ${change.new_value}` };
    }
  }
  const editableFields: Array<keyof Commitment> = [
    "status",
    "horizon",
    "deadline",
    "owner",
    "title",
    "notes",
  ];
  if (!editableFields.includes(change.field)) {
    return { ok: false, error: `field not editable: ${change.field}` };
  }

  const token = crypto.randomUUID();
  const record: ProposalRecord = {
    kind: "update",
    payload: { change },
    user,
    proposedAt: Date.now(),
    source,
  };
  await env.BRAIN_MEMORY.put(`commitment-proposal:${token}`, JSON.stringify(record), {
    expirationTtl: PROPOSAL_TTL_SECONDS,
  });

  return {
    ok: true,
    descriptor: {
      token,
      kind: "commitment-update",
      description: await buildDescription(env, record),
      preview: record.payload,
      source,
      expires_in: PROPOSAL_TTL_SECONDS,
    },
  };
};

const applyProposal = async (
  env: Env,
  record: ProposalRecord,
  user: SessionUser
): Promise<{ commitSha: string; commitMessage: string }> => {
  const all = await fetchAllCommitments(env);
  let updated: Commitment[];
  let commitMessage: string;

  if (record.kind === "create" && record.payload.new_commitment) {
    const nc = record.payload.new_commitment;
    const newCommitment: Commitment = {
      id: await generateId(env),
      owner: nc.owner || user.email.split("@")[0],
      title: (nc.title || "").trim().slice(0, 200),
      created: todayStr(),
      deadline: nc.deadline || null,
      horizon: VALID_HORIZONS.includes(nc.horizon as CommitmentHorizon)
        ? (nc.horizon as CommitmentHorizon)
        : "later",
      status: VALID_STATUSES.includes(nc.status as CommitmentStatus)
        ? (nc.status as CommitmentStatus)
        : "open",
      source: nc.source || `via ${record.source}, by ${user.email}`,
      completed: null,
      notes: (nc.notes || "").slice(0, 500),
    };
    updated = [...all, newCommitment];
    commitMessage = `commitments: + ${newCommitment.title.slice(0, 60)} (via ${record.source})`;
  } else if (record.kind === "update" && record.payload.change) {
    const ch = record.payload.change;
    const idx = all.findIndex((c) => c.id === ch.id);
    if (idx === -1) {
      throw new Error(`commitment not found: ${ch.id}`);
    }
    const existing = all[idx];
    const next: Commitment = { ...existing };
    const value = ch.new_value;

    switch (ch.field) {
      case "status":
        next.status = value as CommitmentStatus;
        if (next.status === "done" && !next.completed) {
          next.completed = todayStr();
        }
        if (next.status !== "done") {
          next.completed = null;
        }
        break;
      case "horizon":
        next.horizon = value as CommitmentHorizon;
        break;
      case "deadline":
        next.deadline = value === null || value === "" ? null : value;
        break;
      case "owner":
        next.owner = value || existing.owner;
        break;
      case "title":
        next.title = (value || existing.title).slice(0, 200);
        break;
      case "notes":
        next.notes = (value || "").slice(0, 500);
        break;
      default:
        throw new Error(`field not editable: ${ch.field}`);
    }
    updated = [...all];
    updated[idx] = next;
    commitMessage = `commitments: ${ch.id} ${ch.field} → ${value} (via ${record.source})`;
  } else {
    throw new Error("malformed proposal");
  }

  const result = await writeCommitments(
    env,
    updated,
    commitMessage,
    user.name,
    user.email
  );
  return { commitSha: result.commitSha, commitMessage };
};

// ---- HTTP handlers ----

export const handleListCommitments = async (
  _request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const commitments = await fetchAllCommitments(ctx.env);
  return new Response(
    JSON.stringify({ commitments, signed_in_as: ctx.user.email }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};

interface CommitmentProposeRequest {
  new_commitment?: Partial<Commitment>;
  change?: { id: string; field: keyof Commitment; new_value: string | null };
}

export const handleCommitmentPropose = async (
  request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const body = (await request.json()) as CommitmentProposeRequest;

  if (!body.new_commitment && !body.change) {
    return new Response(
      JSON.stringify({ error: "must provide new_commitment or change" }),
      { status: 400, headers: { "content-type": "application/json", ...cors } }
    );
  }

  const result = body.new_commitment
    ? await proposeCreate(ctx.env, ctx.user, body.new_commitment, "dashboard")
    : await proposeUpdate(ctx.env, ctx.user, body.change!, "dashboard");

  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  return new Response(
    JSON.stringify({
      token: result.descriptor.token,
      kind: result.descriptor.kind === "commitment-create" ? "create" : "update",
      preview: result.descriptor.preview,
      expires_in: result.descriptor.expires_in,
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};

export const handleCommitmentConfirm = async (
  request: Request,
  ctx: { user: SessionUser; env: Env },
  cors: Record<string, string>
): Promise<Response> => {
  const body = (await request.json()) as { token: string };
  if (!body.token) {
    return new Response(JSON.stringify({ error: "token is required" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const stored = await ctx.env.BRAIN_MEMORY.get(`commitment-proposal:${body.token}`);
  if (!stored) {
    return new Response(JSON.stringify({ error: "proposal expired or not found" }), {
      status: 404,
      headers: { "content-type": "application/json", ...cors },
    });
  }
  const record = JSON.parse(stored) as ProposalRecord;

  if (record.user.email !== ctx.user.email) {
    return new Response(
      JSON.stringify({ error: "proposal belongs to a different user" }),
      { status: 403, headers: { "content-type": "application/json", ...cors } }
    );
  }

  try {
    const result = await applyProposal(ctx.env, record, ctx.user);
    await ctx.env.BRAIN_MEMORY.delete(`commitment-proposal:${body.token}`);
    return new Response(
      JSON.stringify({
        ok: true,
        commit_sha: result.commitSha,
        commit_url: `https://github.com/${ctx.env.GITHUB_REPO}/commit/${result.commitSha}`,
      }),
      { headers: { "content-type": "application/json", ...cors } }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "apply failed";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "content-type": "application/json", ...cors },
    });
  }
};
