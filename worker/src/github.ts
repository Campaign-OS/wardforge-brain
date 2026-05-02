/**
 * GitHub substrate retrieval. The brain reads from the repo at request time
 * via the GitHub API. No caching layer in the MVP — Workers have low latency
 * to GitHub and queries are infrequent. Add KV caching if request times exceed
 * 3-4 seconds at scale.
 */

import type { Env } from "./index";

const GH_API = "https://api.github.com";

const ghHeaders = (token: string): HeadersInit => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "wardforge-brain",
});

export const fetchFile = async (env: Env, path: string): Promise<string> => {
  const url = `${GH_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const r = await fetch(url, { headers: ghHeaders(env.GITHUB_TOKEN) });
  if (!r.ok) {
    if (r.status === 404) return `(${path} not found)`;
    throw new Error(`github fetchFile ${path}: ${r.status} ${await r.text()}`);
  }
  const data = (await r.json()) as { content: string; encoding: string };
  if (data.encoding !== "base64") {
    return `(unsupported encoding for ${path})`;
  }
  // atob handles base64; the content is utf-8 bytes after decode
  const bin = atob(data.content.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

export const listDir = async (env: Env, path: string): Promise<string[]> => {
  const url = `${GH_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const r = await fetch(url, { headers: ghHeaders(env.GITHUB_TOKEN) });
  if (!r.ok) {
    if (r.status === 404) return [];
    throw new Error(`github listDir ${path}: ${r.status}`);
  }
  const items = (await r.json()) as Array<{ name: string; type: string; path: string }>;
  return items.filter((i) => i.type === "file").map((i) => i.path);
};

export const fetchRecentCommits = async (env: Env, days = 7): Promise<string[]> => {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const url = `${GH_API}/repos/${env.GITHUB_REPO}/commits?since=${since}&per_page=50`;
  const r = await fetch(url, { headers: ghHeaders(env.GITHUB_TOKEN) });
  if (!r.ok) return [];
  const commits = (await r.json()) as Array<{
    sha: string;
    commit: { message: string; author: { name: string } };
  }>;
  return commits.map(
    (c) => `- ${c.sha.slice(0, 7)} (${c.commit.author.name}): ${c.commit.message.split("\n")[0]}`
  );
};

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : text.slice(0, maxChars) + "\n\n[...truncated...]";

/**
 * Build the substrate context for a query. Pulls a curated set of docs that
 * collectively represent "what the company knows about itself."
 *
 * Token-bounded — each piece is truncated. Total target: ~30K chars (≈8K tokens).
 * If you add more substrate later, watch the total size.
 */
export const buildSubstrateContext = async (env: Env): Promise<string> => {
  const [
    architecture,
    buildPlan,
    features,
    legalRegulatory,
    adrFiles,
    stateFiles,
    commits,
  ] = await Promise.all([
    fetchFile(env, "docs/architecture.md").then((t) => truncate(t, 6000)),
    fetchFile(env, "docs/build-plan.md").then((t) => truncate(t, 6000)),
    fetchFile(env, "docs/features.md").then((t) => truncate(t, 6000)),
    fetchFile(env, "docs/research/legal-regulatory.md").then((t) => truncate(t, 4000)),
    listDir(env, "docs/decisions"),
    listDir(env, "docs/state"),
    fetchRecentCommits(env, 14),
  ]);

  // Pull last 5 ADRs by name (assumes NNNN-name.md sorting)
  const recentAdrPaths = adrFiles
    .filter((p) => p.endsWith(".md") && !p.endsWith("_template.md"))
    .sort()
    .slice(-5);
  const adrContents = await Promise.all(
    recentAdrPaths.map(async (p) => `=== ${p} ===\n${truncate(await fetchFile(env, p), 2000)}`)
  );

  // Pull last 4 weekly state files (founder docs + synthesis)
  const recentStatePaths = stateFiles
    .filter((p) => p.endsWith(".md") && !p.endsWith("_template.md") && !p.endsWith("README.md"))
    .sort()
    .slice(-6);
  const stateContents = await Promise.all(
    recentStatePaths.map(
      async (p) => `=== ${p} ===\n${truncate(await fetchFile(env, p), 2000)}`
    )
  );

  return [
    "# WardForge Substrate",
    "",
    "## Architecture",
    architecture,
    "",
    "## Build plan",
    buildPlan,
    "",
    "## Features",
    features,
    "",
    "## Legal / regulatory research",
    legalRegulatory,
    "",
    "## Recent ADRs",
    adrContents.join("\n\n") || "(no ADRs)",
    "",
    "## Recent weekly states & syntheses",
    stateContents.join("\n\n") || "(no state docs)",
    "",
    "## Commits — past 14 days",
    commits.join("\n") || "(no commits)",
  ].join("\n");
};

/**
 * Append a line to docs/inbox.md. Used by Layer 3 inbox action.
 * Commits via the contents API (read SHA, write updated content).
 */
export const appendToInbox = async (
  env: Env,
  line: string,
  authorName: string,
  authorEmail: string
): Promise<{ commitSha: string }> => {
  const path = "docs/inbox.md";
  const url = `${GH_API}/repos/${env.GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const getResp = await fetch(url, { headers: ghHeaders(env.GITHUB_TOKEN) });
  if (!getResp.ok) throw new Error(`could not read inbox: ${getResp.status}`);
  const file = (await getResp.json()) as { content: string; sha: string };
  const current = atob(file.content.replace(/\n/g, ""));

  // Insert under today's date heading; create heading if missing.
  const today = new Date().toISOString().slice(0, 10);
  const dateHeading = `## ${today}`;
  let updated: string;
  if (current.includes(dateHeading)) {
    updated = current.replace(dateHeading, `${dateHeading}\n\n- ${line}`);
  } else {
    // Find the "---" separator; insert a new section right after it.
    const marker = "\n---\n";
    if (current.includes(marker)) {
      updated = current.replace(marker, `${marker}\n${dateHeading}\n\n- ${line}\n`);
    } else {
      updated = `${current.trimEnd()}\n\n${dateHeading}\n\n- ${line}\n`;
    }
  }

  // Re-encode to base64
  const bytes = new TextEncoder().encode(updated);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const newContent = btoa(bin);

  const putResp = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(env.GITHUB_TOKEN), "content-type": "application/json" },
    body: JSON.stringify({
      message: `inbox: ${line.slice(0, 60)} (via brain, by ${authorEmail})`,
      content: newContent,
      sha: file.sha,
      committer: { name: "wardforge-brain", email: "[email protected]" },
      author: { name: authorName, email: authorEmail },
    }),
  });
  if (!putResp.ok) {
    throw new Error(`inbox commit failed: ${putResp.status} ${await putResp.text()}`);
  }
  const result = (await putResp.json()) as { commit: { sha: string } };
  return { commitSha: result.commit.sha };
};
