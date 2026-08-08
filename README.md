# Auto Reg Advisor (v4)

Global automotive regulation Q&A, grounded in official sources (NHTSA, EPA, UNECE, EU Commission, UK VCA, Japan MLIT, India MoRTH, Australia). Rebuilt to **load instantly, never sleep, and cost $0**.

**What changed from v1 (the Streamlit version):**
- Streamlit → **static page + serverless function**. The page is plain HTML, so it opens instantly and never spins down.
- Firecrawl (paid) → **Jina Reader (free, no key)** for scraping.
- Interregs.net (paid subscription) → **dropped**.
- Kept **Cerebras Llama-4-Scout** (free tier) for answers, with a strict "answer only from sources, never invent" prompt.
- Added a **nightly GitHub Action** that refreshes source snapshots automatically — no babysitting.

---

## Deploy in 4 steps (~15 min, one time)

### 1 · Get a free LLM key
- Go to **cloud.cerebras.ai** → sign up (free) → create an API key. It looks like `csk-...`.
- (Alternative: a free **Groq** key from console.groq.com works too — see `.env.example`.)

### 2 · Put this folder on GitHub
- Create a new repo (e.g. `auto-reg-advisor`).
- Upload everything in this folder (or `git push` it). You can reuse your existing `Pivot12/SimFreeAutoRegAdvisor2` repo — just replace its contents with these files.

### 3 · Deploy on Vercel (free, never sleeps)
- Go to **vercel.com** → sign in with GitHub → **Add New → Project** → import the repo.
- Framework preset: **Other** (no build step needed). Click **Deploy**.
- After it deploys: **Settings → Environment Variables** → add
  `CEREBRAS_API_KEY = csk-...` → **Redeploy**.
- You now have a live URL like `https://auto-reg-advisor.vercel.app` — it loads instantly, every time.

### 4 · Turn on the nightly refresh
- It's already wired (`.github/workflows/refresh.yml`). Once the repo is on GitHub, open the **Actions** tab → enable workflows.
- To test it now: Actions → "Nightly source refresh" → **Run workflow**. It will commit fresh snapshots to `data/cache/`.

That's it. Put the Vercel URL on your resume in place of the dead Streamlit link.

---

## How it works
1. `public/index.html` — the chat UI (static, instant).
2. `api/ask.js` — serverless: routes the question to the right agencies (`data/sources.json`), scrapes them live via Jina Reader, and asks Cerebras/Llama to answer **only** from that text, with citations.
3. `scripts/refresh.mjs` + the Action — nightly snapshot of every source into `data/cache/` so the app stays current on its own.

## Maintenance = near zero
- **Add/remove a regulatory body:** edit `data/sources.json` only.
- **Swap the LLM:** change env vars (see `.env.example`).
- Everything else runs itself.

## Disclaimer
Reference tool only. Always verify with the official authority before compliance decisions.
