# AXIS — AI Company OS

One person + 7 AI agents. Semi-auto: agents draft, you approve, then it executes.
Powered by Anthropic Claude API (personal account). No enterprise required.

---

## Stack
- **Backend**: Node.js + Express on Vercel serverless (or any Node host)
- **Database**: Supabase free tier (PostgreSQL)
- **AI**: Anthropic Claude API — personal account
- **Dashboard**: Static HTML — host on Vercel/Netlify (separate deployment)
- **Cost**: ~₹0 infrastructure. Pay only for API tokens used.

---

## Setup — 6 steps, ~20 minutes

### Step 1 — Database (Supabase, free)
1. Go to https://supabase.com → New project
2. Save your password somewhere safe
3. Go to: Settings → Database → Connection string → URI
4. Copy the connection string — looks like: `postgresql://postgres:PASSWORD@db.XXXXX.supabase.co:5432/postgres`

### Step 2 — Anthropic API key (personal account)
1. Go to https://console.anthropic.com/settings/keys
2. Create a new key → copy it
3. Add $5–10 credit (Settings → Billing)

### Step 3 — Local setup
```bash
git clone <your-repo> axis-app
cd axis-app
npm install
cp .env.example .env
# Edit .env — fill in ANTHROPIC_API_KEY and DATABASE_URL
node db/init.js    # Creates all tables
npm run dev        # Starts on http://localhost:3001
# Test: curl http://localhost:3001/health
```

### Step 4 — Deploy backend to Vercel (free)
```bash
npm install -g vercel
vercel login
# In axis-app directory:
vercel
# When prompted, set environment variables:
# ANTHROPIC_API_KEY = your key
# DATABASE_URL      = your supabase connection string
# JWT_SECRET        = any random 32-char string
```
Your backend URL will be: `https://axis-ai-company-os.vercel.app`

### Step 5 — Deploy dashboard
Option A — Vercel (separate project):
```bash
cd dashboard
vercel
# Just the static HTML — deploys in seconds
```
Your dashboard URL: `https://axis-dashboard.vercel.app`

Option B — Netlify:
- Drag the `dashboard/` folder to https://app.netlify.com/drop

### Step 6 — Connect dashboard to backend
1. Open your dashboard URL
2. Click the red "API not set" pill (top right)
3. Enter your backend URL: `https://axis-ai-company-os.vercel.app`
4. Click "Test & Connect"
5. Done — you're live

---

## How to use (daily workflow)

### Run an agent
1. Click ⚡ Run Agent (sidebar or top button)
2. Select which agent (STRAT, CREO, VISU, etc.)
3. Write your prompt — be specific
4. Wait 10–30 seconds
5. Check the **Drafts** tab — your draft appears there

### Review and approve
1. Go to **Drafts** tab
2. Read the AI output
3. Click **✓ Approve** → marked done, added to activity log
4. OR: add feedback in the text box → **↺ Redo with feedback** → agent revises
5. OR: add feedback → **✗ Reject** → task marked rejected with your reason

### Track everything
- **Dashboard** — live stats on cost, drafts, tasks, activity
- **Interventions** — things only you can do (bank details, account verifications, decisions)
- **Hurdles** — blockers flagged by you or agents
- **Feedback Loops** — iterate on what's working

---

## Agent roster

| Agent | Model | Best for |
|-------|-------|----------|
| 🧠 STRAT | claude-opus-4-5 | Market research, niche validation, strategy |
| ✍️ CREO | claude-sonnet-4-6 | Ebook chapters, scripts, blog posts |
| 🎨 VISU | claude-sonnet-4-6 | Midjourney prompts, design briefs |
| 📈 GRWTH | claude-haiku-4-5-20251001 | SEO, Etsy tags, keyword research |
| 🔧 OPSY | claude-haiku-4-5-20251001 | Platform listings, publishing copy |
| 💰 FINU | claude-haiku-4-5-20251001 | P&L reports, cost tracking |
| ⚙️ DEVI | claude-opus-4-5 | Code, automation scripts, API integrations |

---

## Estimated costs (India)

| Period | Usage | AI cost |
|--------|-------|---------|
| Month 1 | Setup + testing | ~$5–15 (~₹500–1,200) |
| Month 2–3 | Daily agent runs | ~$20–50 (~₹1,700–4,200) |
| Month 4+ | Full automation | ~$50–150 (~₹4,200–12,500) |

Infrastructure cost: **₹0** (Vercel free + Supabase free)

---

## Adding more capabilities later
- **Etsy auto-publish**: Add `ETSY_API_KEY` to .env → OPSY can post listings
- **YouTube auto-upload**: Add `YOUTUBE_API_KEY` → OPSY handles scheduling
- **n8n workflows**: Self-host n8n on a VM for multi-step automations
- **More agents**: Add to `agents/agents.js` with a new system prompt
