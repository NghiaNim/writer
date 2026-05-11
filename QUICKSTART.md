# Quick Start Guide

Get LLM Council Plus running in under 10 minutes.

This project has **two deployment modes**:
- **Hosted mode**: Supabase auth, per-user voice + memory, multi-user — the way the Essay Coach is meant to run.
- **Self-hosted dev mode**: single-user, no auth, settings in `data/settings.json` — fast to try locally.

---

## 1. Prerequisites

- **Python 3.10+**
- **Node.js 18+**
- **[uv](https://docs.astral.sh/uv/)** — install with: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **(Hosted mode only)** a free [Supabase](https://supabase.com/) project

---

## 2. Install

```bash
# Clone the repo
git clone https://github.com/jacob-bd/llm-council-plus.git
cd llm-council-plus

# Install dependencies
uv sync
cd frontend && npm install && cd ..
```

---

## 3. (Hosted mode) Supabase setup

Skip this whole section if you just want the legacy self-hosted dev mode.

### 3a. Apply migrations

In your Supabase project's SQL editor, run every file in `supabase/migrations/` in order:

```
001_initial.sql
002_essay_extensions.sql
003_voice_library_and_review_queue.sql
004_essay_memory_and_user_facts.sql
005_user_fact_categories.sql
006_conversations.sql
007_fact_archive_and_cleanup.sql
```

Each is idempotent — safe to re-run. After migration 003, seed the voice library:

```bash
uv run python -m backend.scripts.seed_voice_library
```

### 3b. Configure env vars

Create `.env` in the project root (or set in your hosting provider):

```bash
# Supabase
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
SUPABASE_JWT_SECRET=...   # found at: Supabase → Project Settings → API → JWT Secret

# Provider keys (server-side, never sent to browser)
OPENROUTER_API_KEY=sk-or-...
GROQ_API_KEY=gsk_...       # optional
GEMINI_API_KEY=...         # optional, used for memory extraction + interim questions

# Optional analytics
POSTHOG_PROJECT_TOKEN=phc_...
```

### 3c. Enable Google OAuth (optional)

In Supabase: **Authentication → Providers → Google → enable**. Add your redirect URLs.

---

## 4. Start the app

```bash
./start.sh
```

Open **http://localhost:5173**. In hosted mode you'll see a login screen; in dev mode it goes straight to the essay flow.

---

## 5. First-Time Setup

In hosted mode, sign up, then **Settings → Council** to pick your 4 council personas + chairman. **Settings → My Voice** is pre-seeded with ~28 default rules.

In self-hosted dev mode, the Settings panel opens automatically.

### Option A: Use OpenRouter (Easiest)
1. Get a free API key at [openrouter.ai/keys](https://openrouter.ai/keys)
2. Paste it in **LLM API Keys** → **OpenRouter**
3. Click **Test** (auto-saves on success)
4. Go to **Council Config** → Select models for your council
5. Click **Save Changes**

### Option B: Use Ollama (Free & Local)
1. Install [Ollama](https://ollama.com/)
2. Pull a model: `ollama pull llama3.1`
3. Start Ollama: `ollama serve`
4. In Settings → **LLM API Keys** → Click **Connect** for Ollama
5. Go to **Council Config** → Enable "Local (Ollama)" → Select models
6. Click **Save Changes**

### Option C: Use Direct APIs
1. Get API keys from your preferred providers (OpenAI, Anthropic, Google, etc.)
2. Enter keys in **LLM API Keys** → **Direct LLM Connections**
3. Click **Test** for each (auto-saves on success)
4. Go to **Council Config** → Enable "Direct Connections" → Select models
5. Click **Save Changes**

---

## 6. Your First Essay

1. Land on the essay flow (or click **+** in the sidebar).
2. **Step 1**: type your topic or paste a draft.
3. **Step 2**: answer 3–5 intake questions the coach asks.
4. **Step 3**: confirm the 1-paragraph core idea.
5. **Step 4**: (optional) pick a voice anchor.
6. The council starts. While drafting:
   - **Stage 1**: 4 personas write essays in parallel.
   - **Interim panel** (gold): you may see 1–2 short questions about gaps the drafts hand-waved. Skipping is fine.
   - **Stage 2**: peers rank each other anonymously.
   - **Chairman clarification** (brighter gold, ~25s window): one final ask if there's a specific vague claim to ground.
   - **Stage 3**: chairman writes the final essay, applying every active voice rule.

After the essay is done you can refine with the chips, save feedback, or start another. The council remembers what you've shared.

---

## 7. Quick Tips

- **Mix model families** for diverse perspectives (e.g., GPT + Claude + Gemini).
- **Use Groq** for speed — ultra-fast inference.
- **Use Ollama** for unlimited local queries (self-hosted dev mode).
- **"I'm Feeling Lucky"** button randomizes your council.
- **Abort anytime** with the stop button in the sidebar.
- **Settings → What We Know** is your memory. Forget anything that's wrong.
- **Settings → My Voice** is where you tune which "AI tells" the council must avoid.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Models not appearing | Check provider is enabled in Council Config |
| Rate limit errors | Use Groq (14k/day) or Ollama (unlimited) |
| Port conflict | Backend uses 8001, frontend uses 5173 |
| node_modules errors | `rm -rf frontend/node_modules && cd frontend && npm install` |

---

## Next Steps

- Explore **System Prompts** to customize model behavior
- Configure **Web Search** providers (Tavily, Brave) for better results
- Adjust **Temperature** sliders for creativity control
- **Export** your council config to share or backup

For full documentation, see [README.md](README.md).

---

<p align="center">
  <em>Ask the council. Get better answers.</em>
</p>
