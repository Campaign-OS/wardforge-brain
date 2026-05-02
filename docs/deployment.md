# Deployment Guide

Click-by-click setup. ~2 hours total. Do this on personal machine (you said DCC laptop can't install Node, and Wrangler needs Node).

## What you need before starting

- Personal machine with Node 20+ installed
- Domain `ward-forge.com` already on Cloudflare (or migrate to Cloudflare first — see Appendix)
- Cloudflare account
- Anthropic API key (you have this)
- GitHub PAT with `repo` scope (you may have this from earlier setup)
- Workspace admin access (for OAuth setup)

## Phase 1 — Cloudflare basics (15 min)

If `ward-forge.com` is still on Squarespace registrar/DNS:

1. **Cloudflare → Add a site → enter `ward-forge.com`.**
2. Pick the Free plan.
3. Cloudflare scans your existing DNS records. Verify it picked up the Workspace MX records, the Resend records, etc.
4. Cloudflare gives you 2 nameservers (e.g. `ada.ns.cloudflare.com` and `bran.ns.cloudflare.com`).
5. **Squarespace → Domains → ward-forge.com → Domain Nameservers → Custom.** Paste Cloudflare's two nameservers.
6. Wait 5-30 minutes for nameserver change to propagate.
7. Cloudflare dashboard will show "Active" once DNS is live.

Email and existing Resend setup keep working — Cloudflare just becomes the DNS host.

If `ward-forge.com` is already on Cloudflare, skip the above.

## Phase 2 — Clone the bundle and install (10 min)

On personal machine:

```bash
# Pick a parent dir for company code
cd ~/code  # or wherever

# Unzip the brain bundle here (or git clone if you've put it in a repo)
# Should end up with: ~/code/wardforge-brain/
cd wardforge-brain

# Install worker deps
cd worker
npm install
cd ..

# Install frontend deps
cd frontend
npm install
cd ..
```

You should be able to type-check both:

```bash
cd worker && npm run typecheck && cd ..
cd frontend && npx tsc --noEmit && cd ..
```

If type-checks pass, you're ready to deploy.

## Phase 3 — Set up Google OAuth (15 min)

The brain authenticates users via Google Workspace. Set up an OAuth client.

1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. Top bar → Create a new project → name it `WardForge`.
3. Left menu → APIs & Services → OAuth consent screen.
4. User Type: **Internal** (only Workspace users — exactly what we want)
5. Fill required fields:
   - App name: `WardForge Brain`
   - User support email: `[email protected]`
   - Developer contact: same
6. Save.
7. Left menu → APIs & Services → Credentials → Create credentials → OAuth client ID.
8. Application type: Web application.
9. Name: `WardForge Brain Worker`.
10. Authorized redirect URIs:
    - `https://brain-api.ward-forge.com/session/callback`
    - `http://127.0.0.1:8787/session/callback` (for local dev)

    Note the path is `/session/callback`, not `/auth/callback`. See "Cloudflare path-block gotcha" near the end of this doc for why.
11. Create. Copy the Client ID and Client Secret — you'll paste these into Wrangler secrets.

## Phase 4 — Deploy the Worker (20 min)

```bash
cd worker

# First-time login
npx wrangler login

# Create the KV namespace for query memory
npx wrangler kv namespace create BRAIN_MEMORY
# It prints something like:
# { binding = "BRAIN_MEMORY", id = "abc123def456..." }
# Paste that id into wrangler.toml — replace REPLACE_WITH_KV_NAMESPACE_ID
```

Open `wrangler.toml` in your editor, paste the KV id.

Set secrets (one at a time — Wrangler prompts you to paste each):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# paste your key

npx wrangler secret put GITHUB_TOKEN
# Fine-grained PAT scoped to the substrate repo (Campaign-OS/wardforge-web).
# Resource owner MUST be Campaign-OS (the org), not your personal account —
# fine-grained PATs only access resources owned by their declared owner.
# Permissions needed: Contents: Read and write (write for inbox commits),
# Metadata: Read, Pull requests: Read.
# If Campaign-OS requires PAT approval (org policy), an org owner must approve
# the request at github.com/organizations/Campaign-OS/settings/personal-access-tokens-pending-requests
# before the token can access org repos. As an interim workaround, a classic
# PAT with `repo` scope + SSO authorization works without approval.

npx wrangler secret put GOOGLE_CLIENT_ID
# paste the OAuth client ID from Phase 3

npx wrangler secret put GOOGLE_CLIENT_SECRET
# paste the OAuth client secret

npx wrangler secret put SESSION_SECRET
# paste a random 32-byte string. Generate one:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Now deploy:

```bash
npx wrangler deploy
```

You'll see something like `https://wardforge-brain.your-account.workers.dev`. The worker is live but at the workers.dev URL. Set up the custom domain:

1. Cloudflare dashboard → Workers & Pages → `wardforge-brain` → Settings → Triggers.
2. Add Custom Domain → `brain-api.ward-forge.com` → Save.
3. Cloudflare auto-configures DNS for it.
4. Wait 1-2 minutes for SSL cert provisioning.

Verify it's live:

```bash
curl https://brain-api.ward-forge.com/healthz
# should return: ok
```

## Phase 5 — Deploy the Frontend (15 min)

```bash
cd frontend

# Build with the production API URL
VITE_API_BASE=https://brain-api.ward-forge.com npm run build
# outputs to frontend/dist
```

Deploy via Cloudflare dashboard (easier first time than CLI):

1. Cloudflare → Workers & Pages → Create → Pages → Upload assets.
2. Project name: `wardforge-brain`.
3. Drag the `frontend/dist` folder → Deploy.
4. After deploy, click the project → Custom domains → Set up custom domain → `brain.ward-forge.com`.

OR via CLI:

```bash
npx wrangler pages deploy dist --project-name=wardforge-brain
```

Then add the custom domain in the dashboard.

Visit `https://brain.ward-forge.com`. You should see the sign-in page.

## Phase 6 — Test the full loop (10 min)

1. Click "Sign in with Google" → authenticate as `[email protected]`.
2. After redirect, you should be on the brain page.
3. Ask a real question: *"What's our highest-risk dependency for the October 26 launch?"*
4. Brain should answer — citing build-plan.md or similar — within 5-15 seconds.
5. Check the sidebar — your question should appear in "Recent questions."
6. Try the inbox proposal: scroll under any answer, click "+ add to inbox", review the proposed line, edit if you want, click Confirm.
7. Check the GitHub repo — `docs/inbox.md` should have a new entry, and there's a new commit by `wardforge-brain`.

If any step fails, the troubleshooting section below covers common issues.

## Phase 7 — Add Matthew (2 min once he has Workspace)

1. Once Matthew has `[email protected]`, no extra config needed.
2. He visits `brain.ward-forge.com`, signs in with his Workspace account, he's in.
3. The OAuth client is `Internal` so any Workspace user is allowed automatically.

---

## Tuning

The system prompt is in `worker/src/prompts.ts`. Edit, redeploy with `npx wrangler deploy`, takes ~10 seconds.

Substrate selection (which docs the brain reads) is in `worker/src/github.ts` → `buildSubstrateContext`. Add or remove pieces as the substrate evolves.

The model is `claude-opus-4-7`. To switch to a faster/cheaper model, edit `MODEL` in `worker/src/brain.ts`.

## Cost expectations

- **Cloudflare Workers**: free tier (100K requests/day). You'll use single-digit hundreds.
- **Cloudflare Pages**: free tier (unlimited).
- **Cloudflare KV**: free tier (100K reads, 1K writes/day). Comfortable.
- **Google OAuth**: free.
- **Anthropic API**: each query costs ~$0.05-0.20 depending on substrate size. At 50 queries/week you're at $10-40/month.

Total: $10-40/month. Scales with usage, not user count.

## Troubleshooting

**Browser GET to `/session/me` returns 403 with `Server: cloudflare`**
- The block is at Cloudflare's edge, not the worker. Confirm with `wrangler tail` — if only OPTIONS appears, the GET is being dropped by an edge protection. Check the response body: bare "403 Forbidden / cloudflare" = generic edge block; "Just a moment..." = JS challenge; "Access denied / Ray ID + error code" = WAF managed rule.
- See "Cloudflare path-block gotcha" above for the `/auth/*` story. If you've added a new auth-adjacent route under a different name and it's blocking, the same fix applies: pick a different path namespace.

**"unauthorized" on every API call**
- Cookie not set — check the redirect URI in Google Cloud Console matches `/session/callback` (not `/auth/callback`).
- SameSite issue — make sure both `brain.ward-forge.com` and `brain-api.ward-forge.com` are HTTPS (Cloudflare handles this automatically).

**Sign-in works but redirects to error**
- The `hd` parameter is set to `ward-forge.com`. If you sign in with a non-Workspace account, you'll get "Access restricted." Sign in with your Workspace account.

**OAuth callback returns "token exchange failed: invalid_client"**
- `GOOGLE_CLIENT_SECRET` on the worker doesn't match what Google has on file. Most common causes: secret was never set, was set with a typo / trailing whitespace, or was rotated in Google Console without being pushed to the worker. Re-run `npx wrangler secret put GOOGLE_CLIENT_SECRET` with the current value from Google Cloud Console → Credentials → your OAuth client → Client secrets.

**Brain returns "github fetchFile: 404" or "the substrate is empty"**
- Either the file path doesn't exist in the repo, or `GITHUB_TOKEN` doesn't have access. If using a fine-grained PAT, confirm the resource owner is `Campaign-OS` (not your personal account) and the org has approved the token. Check `troyc9977` on the token page — if it says "Access on troyc9977", the token is personal-scoped and can't see org repos. Generate a new one with `Resource owner: Campaign-OS`.

**Brain returns "anthropic api 401"**
- ANTHROPIC_API_KEY is wrong. Re-set with `npx wrangler secret put ANTHROPIC_API_KEY`.

**Brain returns "anthropic api 429"**
- Rate-limited. Wait a minute or check Anthropic console for usage tier.

**Inbox commit fails**
- GITHUB_TOKEN needs `Contents: Read and write` on the substrate repo, not just read. Update PAT permissions.

**Worker deploy fails with "no KV namespace"**
- The KV id in wrangler.toml is still the placeholder. Run the create command and paste the real id.

**`brain.ward-forge.com` shows old bundle after deploy**
- Pages deployed to preview, not production. Verify `wrangler pages deploy` ran with `--branch=main`. Then bust browser cache: DevTools → Application → Storage → Clear site data, close tab, reopen.

## Layer 2 verification

After a few queries, hit `/api/history` directly in your browser (must be signed in):
```
https://brain-api.ward-forge.com/api/history?limit=5
```
You should see the JSON of recent queries. If empty, the KV namespace isn't binding correctly — check wrangler.toml.

## Layer 3 — adding new actions

The pattern in `actions.ts` is propose-then-confirm. To add a new action type (e.g., draft an ADR):

1. Add `handleAdrPropose` and `handleAdrConfirm` to `actions.ts`.
2. In `index.ts`, route `POST /api/actions/adr` and `POST /api/actions/adr/confirm`.
3. The proposal step calls Claude API to draft the ADR markdown.
4. The confirmation step uses GitHub contents API (like `appendToInbox`) to commit a new file under `docs/decisions/`.
5. Add a UI button in `App.tsx` that triggers the propose flow and shows the draft in the modal.

Total new-action cost: ~30-60 minutes per type. Keep proposals reversible (file additions, draft PRs) before any non-reversible actions.

## Operational notes & Cloudflare path-block gotcha

The auth routes are `/session/*` (not `/auth/*`) for a non-obvious reason. Documenting it here so future-you doesn't try to "clean up" the naming.

**The story.** During first deployment, every browser GET to `/auth/me` returned 403 with `Server: cloudflare` and an HTML body — the request was being rejected at Cloudflare's edge before reaching the worker. Tail logs confirmed only the OPTIONS preflight reached the worker; the GET was dropped silently (no Security Events entries). PowerShell calls with the same headers passed through fine and got 401 from the worker as expected. Same headers, same URL, different outcome based on whether the client looked like a browser.

**What we ruled out, in order**: Bot Fight Mode (off), Browser Integrity Check (off), Cloudflare Access (no app configured), edge-cached 403 (purge cache + Dev Mode didn't help), CORS (preflight succeeded), worker route binding (PowerShell got through), TLS fingerprint (no — even after the fix, browser-shaped PowerShell still passed). Then we tested other paths: `/healthz` worked from browser, `/auth/whatever` 403'd from browser. The block was specifically `/auth/*`, browser-keyed, silent.

**Best theory**: a Cloudflare Free-tier credential-stuffing heuristic that auto-blocks `/auth/*` paths for browser-class clients. It's not in the documented WAF managed rules, doesn't appear in Security Events, and "Skip all managed rules" via WAF custom rule did not fully unblock it.

**The fix**: rename routes from `/auth/*` to `/session/*`. Five-minute change in `worker/src/index.ts`, `worker/src/auth.ts`, `frontend/src/api.ts`, plus the OAuth redirect URI in Google Cloud Console. The block evaporated because there's no protection on `/session/*`.

**The WAF custom rule we left in place** (Security → WAF → Custom rules → "Skip managed rules for API"): hostname equals `brain-api.ward-forge.com`, action Skip, all managed rules + Super Bot Fight Mode + Browser Integrity Check + a few others. It didn't fix the `/auth/*` block by itself but it's the right belt-and-suspenders config for an API hostname — managed rules are designed for user-facing web traffic, not JSON APIs called by your own frontend. Leave it.

**Practical implication**: be careful what paths you name. Anything that looks like an authentication endpoint (`/login`, `/signin`, `/oauth`, `/auth/*`) may trigger the same heuristic. If you're adding a new auth-adjacent route, prefer `/session/*` namespace or test explicitly with a browser before assuming Cloudflare won't intercept.

## One-command deploy

The repo isn't wired to Pages auto-deploy (the project was originally created as Direct Upload). Use this script instead — pushes to GitHub, deploys worker, builds frontend, deploys to production. ~30 seconds total.

Save as `deploy.ps1` at the repo root:

```powershell
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "→ Committing & pushing to GitHub" -ForegroundColor Cyan
Set-Location $root
git add -A
git commit -m "deploy" --allow-empty | Out-Null
git push

Write-Host "→ Deploying worker" -ForegroundColor Cyan
Set-Location "$root\worker"
npx wrangler deploy

Write-Host "→ Building & deploying frontend" -ForegroundColor Cyan
Set-Location "$root\frontend"
npm run build
npx wrangler pages deploy dist --project-name=wardforge-brain-ui --branch=main

Set-Location $root
Write-Host "✓ Done" -ForegroundColor Green
```

Run with `.\deploy.ps1` from the repo root. The `--branch=main` flag is critical — without it Pages deploys to a preview URL, not production at `brain.ward-forge.com`.

## Worker secrets reference

Five secrets must be set on the worker. Verify with `npx wrangler secret list` from `worker/`:

| Secret                  | What it is                                                                           |
|-------------------------|--------------------------------------------------------------------------------------|
| `ANTHROPIC_API_KEY`     | Anthropic API key for the brain's Claude calls.                                      |
| `GITHUB_TOKEN`          | Fine-grained PAT, owner = `Campaign-OS`, contents read/write on the substrate repo.  |
| `GOOGLE_CLIENT_ID`      | OAuth 2.0 Client ID from Google Cloud Console → Credentials.                         |
| `GOOGLE_CLIENT_SECRET`  | OAuth 2.0 Client Secret. **Never commit, never paste in screenshots, rotate if leaked.** |
| `SESSION_SECRET`        | Random 32-byte hex string for HMAC-signing session cookies.                          |

Plus three plain vars in `wrangler.toml` `[vars]`: `GITHUB_REPO`, `ALLOWED_DOMAIN`, `FRONTEND_ORIGIN`.

The frontend has one build-time env var, set in Cloudflare Pages → wardforge-brain-ui → Settings → Variables and Secrets:

| Variable          | Value                                  |
|-------------------|----------------------------------------|
| `VITE_API_BASE`   | `https://brain-api.ward-forge.com`     |

## Maintenance

- **Once a quarter**: rotate `SESSION_SECRET` (forces all users to re-login, low cost).
- **Once a quarter**: review and tune system prompt based on what the brain has been getting wrong.
- **Anytime substrate grows**: check `buildSubstrateContext` truncation limits — total should stay under ~30K chars.

## Appendix: Migrate DNS from Squarespace to Cloudflare

If you skipped Phase 1 because you're not ready to migrate DNS yet, you can still deploy the brain — but you'll need to add CNAME records in Squarespace pointing to Cloudflare's targets. Easier to just migrate DNS to Cloudflare; it's a one-hour job and gives you better DNS UI plus free certificates plus DDoS protection. Worth doing.
