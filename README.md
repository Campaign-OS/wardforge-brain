# WardForge Brain

Three-layer internal AI surface for WardForge. Anyone in the company asks `brain.wardforge.com` a question; the brain answers using the company's full substrate.

## The three layers

**Layer 1 — Unified query surface.** A single web page anyone in the company can hit. Behind it: a Cloudflare Worker that loads relevant substrate (architecture, ADRs, weekly states, recent commits) and calls the Anthropic API with a curated prompt.

**Layer 2 — Conversation memory.** Every query is logged to `docs/brain/queries/`. The history itself becomes substrate the next query can reference. Onboarding becomes "read the brain's history."

**Layer 3 — Action-taking.** Brain can propose actions (add to inbox, draft an ADR, open a PR) that humans approve before execution. Strictly opt-in per action type, gated by repeated successful proposals.

## Why this architecture

- **Cloudflare Pages + Workers**: same stack as the eventual product, no new platform to learn, free tier covers internal usage indefinitely.
- **GitHub as the substrate source**: the brain reads from the repo via GitHub API at request-time. No separate database. No sync. The repo is canonical.
- **Anthropic API directly**: same as the workflows. Pay per query, no infrastructure to maintain.
- **Google Workspace SSO**: only `@ward-forge.com` accounts can access. Everyone authenticates as themselves.

## What this is not

- It is not a chatbot for end users. Internal only.
- It is not a search engine. It synthesizes; it does not retrieve.
- It does not store secrets or PII. Substrate goes in only what's safe to share with anyone in the company.
- It does not act autonomously. Layer 3 always proposes; humans always confirm.

## Repo layout

```
wardforge-brain/
├── frontend/               # React app, deployed to Cloudflare Pages
│   ├── src/
│   │   ├── App.tsx         # Single-page chat interface
│   │   ├── main.tsx        # Entry point
│   │   ├── api.ts          # Worker client
│   │   └── styles.css      # Tailwind styles
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   └── tsconfig.json
├── worker/                 # Cloudflare Worker, the brain backend
│   ├── src/
│   │   ├── index.ts        # Worker entry, routing, auth
│   │   ├── brain.ts        # Layer 1: query handling
│   │   ├── memory.ts       # Layer 2: query history logging
│   │   ├── actions.ts      # Layer 3: action proposals
│   │   ├── github.ts       # Substrate retrieval from GitHub
│   │   ├── auth.ts         # Google Workspace SSO
│   │   └── prompts.ts      # System prompts (tunable)
│   ├── package.json
│   ├── tsconfig.json
│   └── wrangler.toml       # Cloudflare config
├── docs/
│   └── deployment.md       # Step-by-step deploy guide
└── README.md               # This file
```

## Deployment timeline

- **Layer 1**: 2-3 hours of focused work. Deploy to Cloudflare. Use it daily for a week.
- **Layer 2**: 1-2 hours after Layer 1 is stable. Adds query logging.
- **Layer 3**: per-action, 30 min each. Build only the actions you actually want, only after Layers 1+2 have been reliable for 2+ weeks.

See `docs/deployment.md` for the actual click-by-click guide.
