/**
 * Commitments — the dashboard's source of truth for tracked work.
 *
 * Lives at docs/state/commitments.md in the substrate repo. Each commitment
 * is a YAML block separated by `---`. The file is canonical; this module
 * parses it for read APIs and rewrites it for write APIs.
 *
 * Why YAML-in-markdown rather than JSON or a database:
 * - Git-tracked: every status change is a commit. Audit comes free.
 * - Human-readable: editable in any text editor without the dashboard.
 * - Brain-readable: already in substrate, parseable in 50 lines of code.
 * - Diff-able: history is git history.
 *
 * Migration path: when this scales past ~200 active commitments or when
 * query patterns demand it, the YAML is a clean export source for a real DB.
 */

import type { Env } from "./index";
import type { SessionUser } from "./auth";
import { fetchFile } from "./github";

const COMMITMENTS_PATH = "docs/state/commitments.md";
const GH_API = "https://api.github.com";

const ghHeaders = (token: string): HeadersInit => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "wardforge-brain",
});

export type CommitmentStatus = "open" | "in-progress" | "blocked" | "done" | "dropped";
export type CommitmentHorizon = "today" | "this-week" | "later";
export type CommitmentOwner = "troy" | "matthew";

export interface Commitment {
  id: string;
  owner: CommitmentOwner | string; // string fallback for unknown owners
  title: string;
  created: string;
  deadline: string | null;
  horizon: CommitmentHorizon;
  status: CommitmentStatus;
  source: string;
  completed: string | null;
  notes: string;
}

const VALID_STATUSES: CommitmentStatus[] = ["open", "in-progress", "blocked", "done", "dropped"];
const VALID_HORIZONS: CommitmentHorizon[] = ["today", "this-week", "later"];

/**
 * Parse a single YAML-ish block into a Commitment. Forgiving — missing
 * fields default sensibly, unknown fields ignored. Not full YAML; we only
 * support `key: value` lines (no nesting, no anchors). That's enough for
 * the schema and avoids pulling in a YAML parser.
 */
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
    // Strip surrounding quotes
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

/**
 * Split the markdown file into YAML blocks. Each block is between `---`
 * separators. The schema/rules section at the top (before the first `---`
 * that follows the first occurrence) is ignored.
 */
const splitBlocks = (markdown: string): string[] => {
  // Normalize line endings
  const normalized = markdown.replace(/\r\n/g, "\n");
  // Split by lines that are exactly `---`
  const sections = normalized.split(/\n---\n/);
  // First section is the schema docs; skip it. Each subsequent section is a commitment block.
  return sections.slice(1).filter((s) => s.trim().length > 0);
};

const formatBlock = (c: Commitment): string => {
  const lines = [
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
  ];
  return lines.join("\n");
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

/**
 * Read all commitments from the substrate. Returns empty array if the file
 * doesn't exist yet — first-time deploy is a clean state.
 */
export const fetchAllCommitments = async (env: Env): Promise<Commitment[]> => {
  const content = await fetchFile(env, COMMITMENTS_PATH);
  if (content.startsWith("(") && content.endsWith(" not found)")) return [];
  const blocks = splitBlocks(content);
  return blocks
    .map(parseBlock)
    .filter((c): c is Commitment => c !== null);
};

/**
 * Write the full commitments list back to the substrate. One commit per
 * change. The dashboard never batches — every change is its own audit entry.
 */
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

  // Get current SHA (or null if file doesn't exist yet)
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
  // For new commitments
  new_commitment?: Partial<Commitment>;
  // For changes to existing commitments
  change?: {
    id: string;
    field: keyof Commitment;
    new_value: string | null;
  };
}

interface ProposalRecord {
  kind: "create" | "update";
  payload: CommitmentProposeRequest;
  user: SessionUser;
  proposedAt: number;
}

const PROPOSAL_TTL_SECONDS = 5 * 60;

const todayStr = (): string => new Date().toISOString().slice(0, 10);

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

  const kind: "create" | "update" = body.new_commitment ? "create" : "update";

  // Validate the payload before storing the proposal
  if (kind === "create" && body.new_commitment) {
    if (!body.new_commitment.title || body.new_commitment.title.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "title is required for new commitments" }),
        { status: 400, headers: { "content-type": "application/json", ...cors } }
      );
    }
  }
  if (kind === "update" && body.change) {
    if (!body.change.id || !body.change.field) {
      return new Response(
        JSON.stringify({ error: "change must include id and field" }),
        { status: 400, headers: { "content-type": "application/json", ...cors } }
      );
    }
  }

  const token = crypto.randomUUID();
  const record: ProposalRecord = {
    kind,
    payload: body,
    user: ctx.user,
    proposedAt: Date.now(),
  };
  await ctx.env.BRAIN_MEMORY.put(`commitment-proposal:${token}`, JSON.stringify(record), {
    expirationTtl: PROPOSAL_TTL_SECONDS,
  });

  return new Response(
    JSON.stringify({
      token,
      kind,
      preview: body,
      expires_in: PROPOSAL_TTL_SECONDS,
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

  const all = await fetchAllCommitments(ctx.env);
  let updated: Commitment[];
  let commitMessage: string;

  if (record.kind === "create" && record.payload.new_commitment) {
    const nc = record.payload.new_commitment;
    const newCommitment: Commitment = {
      id: await generateId(ctx.env),
      owner: nc.owner || ctx.user.email.split("@")[0],
      title: (nc.title || "").trim().slice(0, 200),
      created: todayStr(),
      deadline: nc.deadline || null,
      horizon: VALID_HORIZONS.includes(nc.horizon as CommitmentHorizon)
        ? (nc.horizon as CommitmentHorizon)
        : "later",
      status: VALID_STATUSES.includes(nc.status as CommitmentStatus)
        ? (nc.status as CommitmentStatus)
        : "open",
      source: nc.source || `manual via dashboard, by ${ctx.user.email}`,
      completed: null,
      notes: (nc.notes || "").slice(0, 500),
    };
    updated = [...all, newCommitment];
    commitMessage = `commitments: + ${newCommitment.title.slice(0, 60)} (via dashboard)`;
  } else if (record.kind === "update" && record.payload.change) {
    const ch = record.payload.change;
    const idx = all.findIndex((c) => c.id === ch.id);
    if (idx === -1) {
      return new Response(JSON.stringify({ error: `commitment not found: ${ch.id}` }), {
        status: 404,
        headers: { "content-type": "application/json", ...cors },
      });
    }
    const existing = all[idx];
    const next: Commitment = { ...existing };
    const value = ch.new_value;

    // Apply the change with type validation
    switch (ch.field) {
      case "status":
        if (!VALID_STATUSES.includes(value as CommitmentStatus)) {
          return new Response(JSON.stringify({ error: `invalid status: ${value}` }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors },
          });
        }
        next.status = value as CommitmentStatus;
        // Auto-stamp completed date when moving to done
        if (next.status === "done" && !next.completed) {
          next.completed = todayStr();
        }
        if (next.status !== "done") {
          next.completed = null;
        }
        break;
      case "horizon":
        if (!VALID_HORIZONS.includes(value as CommitmentHorizon)) {
          return new Response(JSON.stringify({ error: `invalid horizon: ${value}` }), {
            status: 400,
            headers: { "content-type": "application/json", ...cors },
          });
        }
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
        return new Response(JSON.stringify({ error: `field not editable: ${ch.field}` }), {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
        });
    }
    updated = [...all];
    updated[idx] = next;
    commitMessage = `commitments: ${ch.id} ${ch.field} → ${value} (via dashboard)`;
  } else {
    return new Response(JSON.stringify({ error: "malformed proposal" }), {
      status: 400,
      headers: { "content-type": "application/json", ...cors },
    });
  }

  const result = await writeCommitments(
    ctx.env,
    updated,
    commitMessage,
    ctx.user.name,
    ctx.user.email
  );

  await ctx.env.BRAIN_MEMORY.delete(`commitment-proposal:${body.token}`);

  return new Response(
    JSON.stringify({
      ok: true,
      commit_sha: result.commitSha,
      commit_url: `https://github.com/${ctx.env.GITHUB_REPO}/commit/${result.commitSha}`,
    }),
    { headers: { "content-type": "application/json", ...cors } }
  );
};
