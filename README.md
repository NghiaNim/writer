# LLM Council Plus

![LLM Council Plus](header.png)

> **An AI essay coach built on a council of models.** Four AI personas draft your essay in parallel, anonymously rank each other, and a Chairman synthesizes a final draft that respects your voice rules and known biographical facts. While the council drafts, the coach asks you short questions to ground vague claims in real specifics.

[![Python 3.10+](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg)](https://reactjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688.svg)](https://fastapi.tiangolo.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What is LLM Council Plus?

**LLM Council Plus** is a multi-user **essay coach** built on a 3-stage LLM council architecture. You give it a topic (or a draft); four AI personas — the Architect, the Editor, the Devil's Advocate, the Voice Guardian — each write a full essay; they anonymously rank each other; a Chairman synthesizes the final.

What makes it more than a model bundle:

- **Persistent memory of you.** Every essay extracts durable facts about the writer (biography, beliefs, experiences). They're injected into every future prompt so essays stay grounded in your actual life. Old facts are folded into a compact summary when they overflow the prompt budget; originals are kept in your "What We Know" panel.
- **Anti-AI-tell voice rules.** Every new user starts with ~28 default rules (no em-dashes, no "delve," no rhetorical-colon noun phrases, no false balance, etc.). All rules are editable; the Voice Guardian and Chairman are required to apply every rule.
- **Interim coaching while we draft.** Stage 1 + Stage 2 takes ~60–90 seconds. The coach uses that time to ask 1–3 short questions about gaps the drafts hand-waved. Your answers feed the chairman synthesis happening right now AND accumulate as durable facts.
- **Chairman clarification.** Right before the final synthesis, the chairman gets one chance to ask you to ground a specific vague claim from the drafts. If everything's already specific, it stays quiet.

<p align="center">
  <div align="center">
    <a href="https://www.youtube.com/watch?v=HOdyIyccOCE" target="_blank">
      <img src="https://img.youtube.com/vi/HOdyIyccOCE/hqdefault.jpg" alt="LLM Council Plus Long Demo" width="48%">
    </a>
    <a href="https://www.youtube.com/watch?v=NUmQFGAwD3g" target="_blank">
      <img src="https://img.youtube.com/vi/NUmQFGAwD3g/hqdefault.jpg" alt="LLM Council Plus Short Demo" width="48%">
    </a>
  </div>
</p>

---

## Installation

```bash
# Clone and install
git clone https://github.com/jacob-bd/llm-council-plus.git
cd llm-council-plus
uv sync                    # Backend dependencies
cd frontend && npm install # Frontend dependencies

# Run (from project root)
./start.sh
```

Then open **http://localhost:5173** and configure your API keys in Settings.

> **Prerequisites:** Python 3.10+, Node.js 18+, [uv](https://docs.astral.sh/uv/)

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        YOUR QUESTION                             │
│            (+ optional web search for real-time info)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    STAGE 1: DELIBERATION                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐             │
│  │ Claude  │  │  GPT-4  │  │ Gemini  │  │  Llama  │  ...        │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘             │
│       │            │            │            │                   │
│       ▼            ▼            ▼            ▼                   │
│  Response A   Response B   Response C   Response D               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    STAGE 2: PEER REVIEW                          │
│  Each model reviews ALL responses (anonymized as A, B, C, D)     │
│  and ranks them by accuracy, insight, and completeness           │
│                                                                   │
│  Rankings are aggregated to identify the best responses          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    STAGE 3: SYNTHESIS                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    CHAIRMAN MODEL                        │    │
│  │  Reviews all responses + rankings + search context       │    │
│  │  Synthesizes the council's collective wisdom             │    │
│  └─────────────────────────────────────────────────────────┘    │
│                              │                                   │
│                              ▼                                   │
│                      FINAL ANSWER                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Essay Coach Features

### Smart intake → council → final essay

```
TOPIC (or draft)
   │
   ▼
INTAKE: 3–5 short Q&A → 1-paragraph core-idea brief
   │
   ▼
COUNCIL (parallel drafts by 4 personas)
   │  ◄── interim_question(×0–2)   "We need one specific moment to ground this."
   ▼
PEER RANKINGS (anonymized)
   │  ◄── interim_question(×0–1)   "Last quick ask before stage 3."
   ▼
CHAIRMAN CLARIFICATION (×0–1)      "About to write your final essay. Confirm one thing."
   │
   ▼
CHAIRMAN SYNTHESIS                 (applies voice rules; folds in your answers)
   │
   ▼
FINAL ESSAY + Refinement chips
```

Every completed essay also extracts categorized facts about you and stores them in your private memory (`user_fact` table). The next essay starts with that memory pre-loaded.

### Voice rules (anti-AI-tell baseline)

Every new user is seeded with ~28 default rules — editable from **Settings → My Voice**. The baseline covers:

| Category | Examples |
|---|---|
| Punctuation | No em-dashes; no rhetorical colon ("The takeaway: …"); semicolons sparingly. |
| Sentence structures | No "It's not X. It's Y." flip; no default tricolons; no "It's worth noting that…" preambles; no "From X to Y" sweeps. |
| Vocabulary | Avoid *delve, navigate, leverage, robust, seamless, holistic, tapestry, journey, foster, pivotal, crucial, paramount*; avoid "in today's fast-paced world," "at the heart of," "speaks volumes." |
| Structure | Don't end every paragraph with a summary; don't open with a question-then-answer; don't begin with a sweeping universal claim; vary paragraph length. |
| Tone | No false balance; no throat-clearing about complexity; no warm-but-empty closer; specifics over abstractions. |
| Positive moves | Concrete nouns and verbs; uneven sentence lengths; name specific people / numbers / works; let the essay have an argument with a stake. |

The Voice Guardian (Stage 1) and the Chairman (Stage 3) are required to apply every active rule. The user's rules override stylistic preferences of any individual model.

### Memory: "What We Know"

A dedicated **Settings → What We Know** panel shows every active fact the council has remembered about you, grouped by category (Biography / Experiences / Beliefs / Interests / Achievements / Relationships / Writers admired / Other). Each row has a **Forget** button. When the memory corpus exceeds the prompt budget, the oldest half is folded into a single summary row — visually distinct — but the originals stay visible in the panel.

### Multi-user, hosted-ready

- **Supabase auth** (email/password + Google OAuth) — every user has their own conversations, voice rules, facts, council config.
- **Row-Level Security** on every table, scoped to `auth.users(id)`.
- The backend uses the service-role key and scopes every query by the JWT-validated user id.
- Self-hosted dev mode keeps the legacy `data/settings.json` config for solo use.

---

## Features

### Multi-Provider Support
Mix and match models from different sources in your council:

| Provider | Type | Description |
|----------|------|-------------|
| **OpenRouter** | Cloud | 100+ models via single API (GPT-4, Claude, Gemini, Mistral, etc.) |
| **Ollama** | Local | Run open-source models locally (Llama, Mistral, Phi, etc.) |
| **Groq** | Cloud | Ultra-fast inference for Llama and Mixtral models |
| **OpenAI Direct** | Cloud | Direct connection to OpenAI API |
| **Anthropic Direct** | Cloud | Direct connection to Anthropic API |
| **Google Direct** | Cloud | Direct connection to Google AI API |
| **Mistral Direct** | Cloud | Direct connection to Mistral API |
| **DeepSeek Direct** | Cloud | Direct connection to DeepSeek API |
| **Custom Endpoint** | Any | Connect to any OpenAI-compatible API (Together AI, Fireworks, vLLM, LM Studio, GitHub Models, etc.) |

<p align="center">
  <img width="600" alt="LLM API Keys Settings" src="https://github.com/user-attachments/assets/f9a5ec9d-17e8-4e78-ad40-0c21850f2823" />
</p>

### Web Search Integration

<p align="center">
  <img width="841" alt="Web Search Settings" src="https://github.com/user-attachments/assets/ae0d8f30-8a0d-4ae2-924b-3de75e9102e1" />
</p>

Ground your council's responses in real-time information:

| Provider | Type | Notes |
|----------|------|-------|
| **DuckDuckGo** | Free | Hybrid web+news search, no API key needed |
| **Serper** | API Key | Real Google results, 2,500 free queries |
| **Tavily** | API Key | Purpose-built for LLMs, rich content |
| **Brave Search** | API Key | Privacy-focused, 2,000 free queries/month |

**Full Article Fetching**: Uses [Jina Reader](https://jina.ai/reader) to extract full article content from top search results (configurable 0-10 results).

### Temperature Controls

<p align="center">
  <img width="586" alt="Temperature Controls" src="https://github.com/user-attachments/assets/3922edf6-99f5-4020-b80f-ba3c43a2ce9a" />
</p>

Fine-tune creativity vs consistency:

- **Council Heat**: Controls Stage 1 response creativity (default: 0.5)
- **Chairman Heat**: Controls final synthesis creativity (default: 0.4)
- **Stage 2 Heat**: Controls peer ranking consistency (default: 0.3)

<p align="center">
  <img width="849" alt="Council Configuration" src="https://github.com/user-attachments/assets/45880bee-1fec-4efc-b1cb-eceaabe071ff" />
</p>

### Additional Features

- **Live Progress Tracking**: See each model respond in real-time
- **Council Sizing**: adjust council size from 2 to 8
- **Abort Anytime**: Cancel in-progress requests
- **Conversation History**: All conversations saved locally
- **Customizable Prompts**: Edit Stage 1, 2, and 3 system prompts
- **Rate Limit Warnings**: Alerts when your config may hit API limits (when >5 council members)
- **"I'm Feeling Lucky"**: Randomize your council composition
- **Import & Export**:  backup and share your favorite council configurations, system prompts, and settings

<p align="center">
  <img width="854" alt="Backup and Reset" src="https://github.com/user-attachments/assets/0e618bd4-02c2-47b2-b82b-c4900b7a4fdd" />
</p>


---

## Quick Start

### Prerequisites

- **Python 3.10+**
- **Node.js 18+**
- **[uv](https://docs.astral.sh/uv/)** (Python package manager)

### Running the Application

**Option 1: Use the start script (recommended)**
```bash
./start.sh
```

**Option 2: Run manually**

Terminal 1 (Backend):
```bash
uv run python -m backend.main
```

Terminal 2 (Frontend):
```bash
cd frontend
npm run dev
```

Then open **http://localhost:5173** in your browser.

### Network Access

The application is configured to be accessible from other devices on your local network.

**Using start.sh (automatic):**
The start script now exposes both frontend and backend on the network automatically. Just run `./start.sh` and access from any device.

**Access URLs:**
- **Local:** `http://localhost:5173`
- **Network:** `http://YOUR_IP:5173` (e.g., `http://192.168.1.100:5173`)

**Find your network IP:**
```bash
# macOS/Linux
ifconfig | grep "inet " | grep -v 127.0.0.1

# Or use hostname
hostname -I
```

**Manual setup (if not using start.sh):**
```bash
# Backend already listens on 0.0.0.0:8001

# Frontend with network access
cd frontend
npm run dev -- --host
```

The frontend automatically detects the hostname and connects to the backend on the same IP. CORS is configured to allow requests from any hostname on ports 5173 and 3000.

---

## Configuration

### First-Time Setup

On first launch, the Settings panel will open automatically. Configure at least one LLM provider:

1. **LLM API Keys** tab: Enter API keys for your chosen providers
2. **Council Config** tab: Select council members and chairman
3. **Save Changes**

### LLM API Keys

| Provider | Get API Key |
|----------|-------------|
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) |
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/) |
| Google AI | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Mistral | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys/) |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/) |

**API keys are auto-saved** when you click "Test" and the connection succeeds.

### Ollama (Local Models)

1. Install [Ollama](https://ollama.com/)
2. Pull models: `ollama pull llama3.1`
3. Start Ollama: `ollama serve`
4. In Settings, enter your Ollama URL (default: `http://localhost:11434`)
5. Click "Connect" to verify

### Custom OpenAI-Compatible Endpoint

Connect to any OpenAI-compatible API:

1. Go to **LLM API Keys** → **Custom OpenAI-Compatible Endpoint**
2. Enter:
   - **Display Name**: e.g., "Together AI", "My vLLM Server"
   - **Base URL**: e.g., `https://api.together.xyz/v1`
   - **API Key**: (optional for local servers)
3. Click "Connect" to test and save

**Compatible services**: Together AI, Fireworks AI, vLLM, LM Studio, Ollama (if you prefer this method), GitHub Models (`https://models.inference.ai.azure.com/v1`), and more.

### Council Configuration

1. **Enable Model Sources**: Toggle which providers appear in model selection
2. **Select Council Members**: Choose 2-8 models for your council
3. **Select Chairman**: Pick a model to synthesize the final answer
4. **Adjust Temperature**: Use sliders for creativity control

**Tips:**
- Mix different model families for diverse perspectives
- Use faster models (Groq, Ollama) for large councils
- Free OpenRouter models have rate limits (20/min, 50/day)

### Search Providers

| Provider | Setup |
|----------|-------|
| DuckDuckGo | Works out of the box, no setup needed |
| Serper | Get key at [serper.dev](https://serper.dev), enter in Search Providers tab |
| Tavily | Get key at [tavily.com](https://tavily.com), enter in Search Providers tab |
| Brave | Get key at [brave.com/search/api](https://brave.com/search/api/), enter in Search Providers tab |

**Search Query Processing:**

| Mode | Description | Best For |
|------|-------------|----------|
| **Direct** (default) | Sends your exact query to the search engine | Short, focused questions. Works best with semantic search engines like Tavily and Brave. |
| **Smart Keywords (YAKE)** | Extracts key terms from your prompt before searching | Very long prompts or multi-paragraph context that might confuse the search engine. Uses [YAKE](https://github.com/LIAAD/yake) keyword extraction. |

> **Tip:** Start with **Direct** mode. Only switch to **YAKE** if you notice search results are irrelevant when pasting long documents or complex prompts.

---

## Usage

### Basic Usage

1. Start a new conversation (+ button in sidebar)
2. Type your question
3. (Optional) Enable web search toggle for real-time info
4. Press Enter or click Send

### Understanding the Output

**Stage 1 - Council Deliberation**
- Tab view showing each model's individual response
- Live progress as models respond

**Stage 2 - Peer Rankings**
- Each model's evaluation and ranking of peers
- Aggregate scores showing consensus rankings
- De-anonymization reveals which model gave which response

**Stage 3 - Chairman Synthesis**
- Final, synthesized answer from the Chairman
- Incorporates best insights from all responses and rankings

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line in input |

---

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Backend** | FastAPI, Python 3.10+, httpx (async HTTP) |
| **Frontend** | React 19, Vite, react-markdown |
| **Styling** | CSS with "Midnight Glass" dark theme |
| **Storage** | JSON files in `data/` directory |
| **Package Management** | uv (Python), npm (JavaScript) |

---

## Data Storage

Two modes, depending on how the app is deployed:

**Hosted mode (Supabase auth on):**
- `voice_profiles`, `essay_sessions`, `essay_memory`, `user_fact`, `conversations`, `user_council_config`, `voice_library` — all in Supabase, RLS-protected per user, FK'd to `auth.users(id)`.
- Provider API keys live in env vars on the server, never in the browser.
- `data/conversations/{user_id}/{conversation_id}.json` for the streaming chat surface.

**Self-hosted dev mode (no Supabase):**
```
data/
├── settings.json          # Your configuration (includes API keys)
└── conversations/         # Conversation history
    ├── {uuid}.json
    └── ...
```

**Privacy**: No data is sent to external servers except API calls to your configured LLM providers (and Supabase, when auth is enabled).

> **⚠️ Security Warning: API Keys Stored in Plain Text**
>
> In this build, **API keys are stored in clear text** in `data/settings.json`. The `data/` folder is included in `.gitignore` by default to prevent accidental exposure.
>
> **Important:**
> - **Do NOT remove `data/` from `.gitignore`** — this protects your API keys from being pushed to GitHub
> - If you fork this repo or modify `.gitignore`, ensure `data/` remains ignored
> - Never commit `data/settings.json` to version control
> - If you accidentally expose your keys, rotate them immediately at each provider's dashboard

---

## Troubleshooting

### Common Issues

**"Failed to load conversations"**
- Backend might still be starting up
- App retries automatically (3 attempts with 1s, 2s, 3s delays)

**Models not appearing in dropdown**
- Ensure the provider is enabled in Council Config
- Check that API key is configured and tested successfully
- For Ollama, verify connection is active

**Jina Reader returns 451 errors**
- HTTP 451 = site blocks AI scrapers (common with news sites)
- Try Tavily/Brave instead, or set `full_content_results` to 0

**Rate limit errors (OpenRouter)**
- Free models: 20 requests/min, 50/day
- Consider using Groq (14,400/day) or Ollama (unlimited)
- Reduce council size for free tier usage

**Binary compatibility errors (node_modules)**
- When syncing between Intel/Apple Silicon Macs:
  ```bash
  rm -rf frontend/node_modules && cd frontend && npm install
  ```

### Logs

- **Backend logs**: Terminal running `uv run python -m backend.main`
- **Frontend logs**: Browser DevTools console

---

## Credits & Acknowledgements

This project is a fork and enhancement of the original **[llm-council](https://github.com/karpathy/llm-council)** by **[Andrej Karpathy](https://github.com/karpathy)**.

**LLM Council Plus** builds upon the original "vibe coded" foundation with:
- Multi-provider support (OpenRouter, Ollama, Groq, Direct APIs, Custom endpoints)
- Web search integration (DuckDuckGo, Tavily, Brave + Jina Reader)
- Essay Coach product layer (smart intake, voice rules, durable user-fact memory, interim Q&A, chairman clarification)
- Temperature controls for all stages
- Enhanced Settings UI with import/export
- Real-time streaming with progress tracking
- And much more...

We gratefully acknowledge Andrej Karpathy for the original inspiration and codebase.

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Contributing

Contributions are welcome! This project embraces the spirit of "vibe coding" - feel free to fork and make it your own.

---

<p align="center">
  <strong>Built with the collective wisdom of AI</strong><br>
  <em>Ask the council. Get better answers.</em>
</p>
