# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LLM Council Plus is a **multi-user Essay Coach** built on an LLM council architecture. A user feeds in a topic (or a draft); four AI council personas pitch competing angles in parallel, a picker chooses one, all four write essays from that shared angle, each persona critiques the strongest draft, and the Chairman revises that draft using the critiques. The final essay respects the user's voice rules and known biographical facts.

**The council pipeline (0.4.0):**
1. **Pitch race** — every persona pitches one paragraph (THESIS / LEAD / KEY MOVE) in parallel; a Gemini-Flash call picks the strongest. All Stage 1 drafts then share that angle.
2. **Stage 1** — 4 personas draft the full essay in parallel from the picked angle. Each persona has a different structural commitment so the drafts diverge in shape, not in thesis.
3. **Spine pick** — a Gemini-Flash call picks the strongest Stage 1 draft. This becomes the SPINE that gets revised.
4. **Stage 2** — each persona produces a surgical critique of the spine (CUT / SHARPEN / KEEP / BORROW from runner-up drafts). NOT a ranking.
5. **Stage 3** — the Chairman REVISES the spine using the consolidated critiques. A directed revision task, not synthesis-from-scratch.

**On top of that loop, the coach adds:**
- **Supabase Auth** (email/password + Google OAuth) — every user has their own profile, conversations, voice, and memory
- **Smart intake** — before the council runs, a short Q&A flow distills the user's topic into a core-idea brief
- **Voice profile** — every new user is seeded with ~28 anti-AI-tell writing rules they can edit; the Voice Guardian and Chairman are required to apply them
- **User facts memory** — facts about the user (biography, beliefs, experiences) are extracted from every completed essay and from interim Q&A, deduped, archived when the corpus overflows, and re-injected into every future prompt
- **Interim questions** — while stages 1 and 2 run (~30–90s of dead time), the backend asks 1–3 short questions about gaps the drafts hand-wave; answers feed the current chairman revision AND accumulate as durable facts
- **Chairman clarification** — right before stage 3, the chairman gets one final chance to ask the user a question pinned to a specific vague claim in the drafts
- **Voice library scaffold** — an invisible random voice anchor borrowed from a curated library of example voices to give each essay rhythmic spine

**Key technical move**: hybrid provider architecture supports OpenRouter (cloud), Ollama (local), Groq (fast inference), direct providers (OpenAI/Anthropic/Google/Mistral/DeepSeek), and custom OpenAI-compatible endpoints.

## Running the Application

**Quick Start:**
```bash
./start.sh
```

**Manual Start:**
```bash
# Backend (from project root)
uv run python -m backend.main

# Frontend (in new terminal)
cd frontend
npm run dev
```

**Ports:**
- Backend: `http://localhost:8001` (NOT 8000 - avoid conflicts)
- Frontend: `http://localhost:5173`

**Network Access:**
```bash
# Backend already listens on 0.0.0.0:8001
# Frontend with network access:
cd frontend && npm run dev -- --host
```

**Installing Dependencies:**
```bash
# Backend
uv sync

# Frontend
cd frontend
npm install
```

**Important**: If switching between Intel/Apple Silicon Macs with iCloud sync:
```bash
rm -rf frontend/node_modules && cd frontend && npm install
```
This fixes binary incompatibilities (e.g., `@rollup/rollup-darwin-*` variants).

## Architecture Overview

### Backend (`backend/`)

**Provider System** (`backend/providers/`)
- **Base**: `base.py` — Abstract interface for all LLM providers
- **Implementations**: `openrouter.py`, `ollama.py`, `groq.py`, `openai.py`, `anthropic.py`, `google.py`, `mistral.py`, `deepseek.py`, `custom_openai.py`
- **Auto-routing**: Model IDs with prefix (`openai:gpt-4.1`, `ollama:llama3`, `custom:model-name`, `google:gemini-2.5-flash`, …) route to the correct provider
- **Routing logic**: `council.py:get_provider_for_model()` parses the prefix

**Core orchestration**

| Module | Purpose |
|--------|---------|
| `council.py` | Stage 1 / 2 / 3 collection, rankings, title generation. Stage 3 now accepts `in_flight_qa_block` and folds it into `student_profile_block`. |
| `main.py` | FastAPI app, SSE streaming endpoint (`/api/conversations/{id}/message/stream`), all intake/voice/memory/auth endpoints. |
| `prompts.py` | Default system prompts for all stages plus templates for `essay_mode_block`, `word_target_block`. |
| `search.py` | Web search: DuckDuckGo, Tavily, Brave + Jina Reader for full article fetch. |
| `settings.py` | App-level config persisted to `data/settings.json` (provider keys, defaults). |
| `storage.py` | Conversation persistence in `data/conversations/{id}.json` (per-user when authed). |

**Auth + Supabase**

| Module | Purpose |
|--------|---------|
| `auth.py` | Email/password signup + login, Google OAuth, JWT validation (`get_current_user` dependency), refresh-token rotation. |
| `supabase_client.py` | Dual Supabase clients (service-role for backend writes; anon for safe selects). |
| `sessions.py` | `/sessions/*` router: create/read/update `essay_sessions`, memory-check against prior topics. |

**Essay coach surface**

| Module | Purpose |
|--------|---------|
| `essay_memory.py` | Upsert one durable row per completed essay into `essay_memory`; feedback recording. |
| `voice_profile.py` | Per-user `voice_profiles` CRUD, review queue (`pending_suggestions`), `format_voice_profile_block()`. **Holds `DEFAULT_VOICE_RULES` (~28 anti-AI-tell rules); seeds on first read.** |
| `voice_library.py` | Read-only voice scaffold pool seeded from `voices/*.json`; `pick_random_voice()` deterministically seeded by `session_id`. |
| `user_facts.py` | Per-user `user_fact` table with category + source. `load_recent_user_facts()` is the hot-path loader; `maybe_summarize_overflow()` folds the oldest active facts into one `'summary'` row when corpus > 8000 chars. Active vs archived split. |
| `memory_extraction.py` | Gemini-Flash extractor that pulls categorized facts from completed essays and short interim Q&A snippets. Calls `maybe_summarize_overflow()` after every insert. |
| `interim_questions.py` | Question generator for the in-flight Q&A (1–2 questions per batch, max 3 per run); chairman clarification generator; process-local answer buffer; `wait_for_answer()` poll helper; `format_in_flight_qa_block()` rendering. |

### Frontend (`frontend/src/`)

| Component | Purpose |
|-----------|---------|
| `App.jsx` | Main orchestration, SSE streaming, conversation state. Handles `interim_question`, `clarification_question`, and `interim_question_answered` events. |
| `contexts/AuthContext.jsx` | Supabase JWT lifecycle: restore from localStorage on mount, refresh tokens, sign-out. |
| `components/Login.jsx` | Email/password + Google OAuth screen. |
| `components/EssayFlow.jsx` | 4-step intake (topic → questions → core idea → voice). Bypassable via draft mode. |
| `components/ChatInterface.jsx` | Main chat surface; renders `<EssayLoadingStatus>` + `<InterimQuestions>` during streaming, `<FinalEssay>` when stage 3 lands. |
| `components/EssayLoadingStatus.jsx` | Terminal-style "the council is working" panel with stage label, progress counter, minimize, tip line about editing rules. |
| `components/InterimQuestions.jsx` | Gold-accented side panel that surfaces interim questions one at a time. Renders chairman clarifications with `interim-questions--chairman` variant. Includes "Here's what the council heard" bullets. |
| `components/FinalEssay.jsx` | Final essay block with regenerate button and council-notes toggle. |
| `components/Stage1.jsx` / `Stage2.jsx` | Raw stage inspectors rendered inside the FinalEssay "Show council notes" disclosure and the aborted-fallback inline notes. The full essay itself is rendered by FinalEssay; there's no Stage3.jsx. |
| `components/CouncilGrid.jsx` / `CouncilChips.jsx` | Visual grid + persona-chip row of council members with provider icons. |
| `components/Sidebar.jsx` | Conversation list (per-user). |
| `components/Settings.jsx` | 7-section settings: Council, System Prompts, **My Voice**, **What We Know** (new), Search Providers, Backup & Reset, plus the LLM API Keys section (hosted-mode hidden). |
| `components/settings/VoiceProfileSettings.jsx` | Edit voice rules (auto-grow textareas so long rules display fully), reference paragraphs, preferred authors, review queue. |
| `components/settings/MemorySettings.jsx` | "What We Know" — facts grouped by category with per-row Forget button; summary rows visually distinct. |
| `components/SearchableModelSelect.jsx` | Searchable dropdown for model selection. |

**Styling**: "Council Chamber" dark theme (refined Midnight Glass). CSS variables in `index.css` (`--font-display`: Syne, `--font-ui`: Plus Jakarta Sans, `--font-content`: Source Serif 4, `--font-code`: JetBrains Mono). Primary accent blue (#3b82f6), chairman gold (#fbbf24). InterimQuestions panel uses chairman-gold accents; chairman-variant adds a thicker border + inner glow.

## Critical Implementation Details

### Python Module Imports
**ALWAYS** use relative imports in backend modules:
```python
from .config import ...
from .council import ...
```
**NEVER** use absolute imports like `from backend.config import ...`

**Run backend as module** from project root:
```bash
uv run python -m backend.main  # Correct
cd backend && python main.py  # WRONG - breaks imports
```

### Model ID Prefix Format
```
openrouter:anthropic/claude-sonnet-4  → Cloud via OpenRouter
ollama:llama3.1:latest                → Local via Ollama
groq:llama3-70b-8192                  → Fast inference via Groq
openai:gpt-4.1                        → Direct OpenAI connection
anthropic:claude-sonnet-4             → Direct Anthropic connection
custom:model-name                     → Custom OpenAI-compatible endpoint
```

### Model Name Display Helper
Use this pattern in Stage components to handle both `/` and `:` delimiters:
```jsx
const getShortModelName = (modelId) => {
  if (!modelId) return 'Unknown';
  if (modelId.includes('/')) return modelId.split('/').pop();
  if (modelId.includes(':')) return modelId.split(':').pop();
  return modelId;
};
```

### Provider Icon Detection (CouncilGrid.jsx)
Check prefixes FIRST before name-based detection to avoid mismatches:
```jsx
const getProviderInfo = (modelId) => {
    const id = modelId.toLowerCase();
    // Check prefixes FIRST (order matters!)
    if (id.startsWith('custom:')) return PROVIDER_CONFIG.custom;
    if (id.startsWith('ollama:')) return PROVIDER_CONFIG.ollama;
    if (id.startsWith('groq:')) return PROVIDER_CONFIG.groq;
    // Then check name-based patterns...
};
```

### Stage 2 Ranking Format
The prompt enforces strict format for parsing:
```
1. Individual evaluations
2. Blank line
3. "FINAL RANKING:" header (all caps, with colon)
4. Numbered list: "1. Response C", "2. Response A", etc.
```
Fallback regex extracts "Response X" patterns if format not followed.

### Streaming & Abort Logic
- Backend checks `request.is_disconnected()` inside loops
- Frontend aborts via AbortController signal
- **Critical**: Always inject raw `Request` object into streaming endpoints (Pydantic models lack `is_disconnected()`)

### ReactMarkdown Safety
```jsx
<div className="markdown-content">
  <ReactMarkdown>
    {typeof content === 'string' ? content : String(content || '')}
  </ReactMarkdown>
</div>
```
Always wrap in `.markdown-content` div and ensure string type (some providers return arrays/objects).

### Tab Bounds Safety
In Stage1/Stage2, auto-adjust activeTab when out of bounds during streaming:
```jsx
useEffect(() => {
  if (activeTab >= responses.length && responses.length > 0) {
    setActiveTab(responses.length - 1);
  }
}, [responses.length]);
```

### Auth + Supabase

- **Auth provider**: Supabase (email/password + Google OAuth). JWT issued by Supabase; access + refresh tokens stored in `localStorage` under key `llm_council_session` by `AuthContext.jsx`.
- **Backend**: every protected endpoint depends on `get_current_user` (`backend/auth.py:111`), which validates the JWT and returns an `AuthUser{id, email}`. The FastAPI app uses the Supabase **service-role** key to bypass RLS and always scopes queries by `user_id` in app code.
- **Env vars required**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`. See `backend/supabase_client.py` and `backend/auth.py`.
- **Migrations**: every essay/voice/memory table FKs to `auth.users(id)` (NOT a local `users` table). RLS policies are belt-and-suspenders against the anon key. See `supabase/migrations/`.

### Essay flow + interim questions

The streaming endpoint (`POST /api/conversations/{id}/message/stream`) yields these SSE event types in order:

```
search_start → search_complete | search_error       (if web_search=true; either-or)
pitch_start → pitch_init → pitch_progress(×N) → pitch_complete
pitch_picked                                         (Flash picks the winning angle)
stage1_start → stage1_init → stage1_progress(×N) → stage1_complete
interim_question(×0–2)                              (after stage 1)
spine_picked                                         (Flash picks the strongest draft)
stage2_start → stage2_init → stage2_progress(×N) → stage2_complete
interim_question(×0–1)                              (after stage 2, if budget remains)
clarification_question(×0–1)                        (chairman pre-pass)
stage3_start → stage3_complete
title_complete                                       (first message in conversation)
run_finished                                         (always, just before complete/error)
complete | error                                     (terminal)
```

**What each phase produces:**

| Phase | What's actually happening |
| --- | --- |
| `pitch_*` | Each council persona writes a one-paragraph pitch (THESIS / LEAD / KEY MOVE / WHY) in parallel. Higher temperature than drafts (~+0.2) so the angle space is genuinely diverged. |
| `pitch_picked` | Single Gemini-Flash call picks the strongest pitch. The picked text is prepended to every Stage 1 prompt as the COUNCIL-AGREED ANGLE so all 4 essays share a thesis. |
| `stage1_*` | 4 personas write the full essay in parallel. Each persona has a STRUCTURAL COMMITMENT (Architect: 3-4 long paragraphs / Editor: 8-12 short paragraphs / Devil's Advocate: open with counterargument / Voice Guardian: open with concrete sensory detail) so the drafts diverge in visible, useful ways. |
| `spine_picked` | Single Flash call picks the strongest draft. This becomes the SPINE the chairman will revise. |
| `stage2_*` | Each council member writes a surgical critique of the spine: CUT / SHARPEN / KEEP / BORROW. NOT a ranking. The runner-up drafts are reference for BORROW only. |
| `stage3_*` | The chairman REVISES the spine using the consolidated critiques. Not a synthesis-from-scratch — a directed revision. |

**`search_error`** is emitted when `perform_web_search` returns the failure placeholder (or raises). The run continues with empty `search_context` — Stage 1 prompts get no web grounding, but the user sees a banner in the assistant message. Frontend persists `metadata.search_error = { provider, message }` on the message.

**`run_finished`** fires immediately before `complete` (or before `error`) so the frontend can lock interim-question inputs. Any late `/api/intake/answer` POST still persists to `user_fact` (good for the next essay) but cannot land in the just-finished chairman synthesis.

**Budget**: `interim_questions.MAX_QUESTIONS_PER_RUN = 3`, `MAX_QUESTIONS_PER_BATCH = 2`. The chairman clarification is **in addition** to that budget — it's the chairman's voice, not the interim coach's.

**Answer flow**: the client POSTs to `/api/intake/answer` with `{conversation_id, question_id, question, answer, skipped, session_id}`. The endpoint:
1. Always appends to a **process-local run buffer** in `interim_questions._run_buffers[conversation_id]` (skips are recorded with `skipped=True, answer=""` so `wait_for_answer` can short-circuit).
2. If `session_id` is present, persists the Q&A onto `essay_sessions.conversation` JSONB for audit and restart safety.
3. Fires `extract_and_store(source="intake", min_chars=40)` so durable facts accumulate in `user_fact` for future essays.

**In-flight injection**: at stage 3, `format_in_flight_qa_block(get_run_buffer(conversation_id))` renders submitted answers into a block that's appended to `student_profile_block`. Existing custom prompt templates pick it up automatically without a new placeholder.

**Chairman clarification**: `generate_chairman_clarification()` is a single Gemini-Flash call seeded by drafts + facts + already-asked. It quotes a specific vague phrase from the drafts and asks one question, or returns `SKIP`. After emitting the SSE event, `wait_for_answer(timeout_s=25)` polls the buffer until the entry appears (answer or skip) or the timeout elapses. Frontend renders it with `chairmanAsk: true` and the `interim-questions--chairman` CSS variant.

### Memory + voice rules

**Voice rules** (`backend/voice_profile.py`):
- `DEFAULT_VOICE_RULES` is a ~28-rule list covering punctuation, sentence structures, vocabulary, structural patterns, tone, and positive rules (the anti-"AI tells" baseline).
- `load_voice_profile()` **seeds on first read**: if no row exists for the user + essay_type, inserts one preloaded with the defaults and returns it. From that moment the row is theirs to edit — emptying the rules list later does **not** reseed.
- Defaults are also exposed at `GET /api/voice-profile/defaults` for a "restore defaults" UI.
- Rule editor in `VoiceProfileSettings.jsx` uses `<AutoGrowTextarea>` so long rules display fully (don't regress this back to `<input>`).

**User facts** (`backend/user_facts.py`):
- One `user_fact` row per durable fact, with `category` (biography / experience / belief / interest / achievement / relationship / reference / general) and `source` (manual / intake / chat / feedback / essay / summary).
- **Active vs archived**: `load_recent_user_facts` filters `archived_at IS NULL`. Archived rows stay in the table so the user can see history in the Memory panel.
- **Summarization on overflow**: `maybe_summarize_overflow()` runs after every `extract_and_store`. When active facts exceed `PROFILE_BLOCK_BUDGET_CHARS = 8000`, it folds the oldest half into one `'summary'` fact (Gemini Flash), inserts it, then marks the originals as `archived_at + superseded_by`. Idempotent and safe to call frequently.
- **Dedupe**: case- and punctuation-insensitive normalization, scanning the user's most recent 200 **active** rows.

**Prompt injection**: both stage 1 and stage 3 call `format_student_profile_block(facts)` which groups facts by category and emits a section like `FACTS THE USER HAS SHARED ABOUT THEMSELVES: …`. The block is rendered into `{student_profile_block}` in every persona template that references it.

### Database schema (migrations)

| File | What it adds |
| --- | --- |
| `001_initial.sql` | `voice_profiles`, `essay_memory`, `essay_sessions` with RLS + `updated_at` triggers. All FK to `auth.users(id)`. |
| `002_essay_extensions.sql` | `essay_sessions.word_target` + `council_config`; new `user_council_config` (per-user default council). |
| `003_voice_library_and_review_queue.sql` | `voice_library` read-only pool; `essay_sessions.voice_library_id`; `voice_profiles.pending_suggestions` (review queue) + `preferred_authors`. |
| `004_essay_memory_and_user_facts.sql` | Links `essay_sessions ↔ conversations`; adds feedback columns to `essay_memory`; creates `user_fact` with category enum. |
| `005_user_fact_categories.sql` | Adds category check (biography / experience / belief / …), `source_essay_id` FK, relevant indexes. |
| `006_conversations.sql` | `conversations` table for per-user chat history JSONB. |
| `007_fact_archive_and_cleanup.sql` | Drops stray `user_profiles` + `brainstorm_drafts`; adds `user_fact.archived_at` + `superseded_by` (self-FK); adds `'summary'` source; active-only index. |

**Always FK to `auth.users(id)`**, never a local `users` table. If you see SQL referencing `users(id)` you have a foreign migration that doesn't fit this codebase — drop it before applying.

## Tunables (UI feature flags)

**Default rule**: any non-trivial UI change goes behind a tunable. Small visual fixes, copy edits, and bug fixes don't need one. Anything that swaps a component, changes a flow, restyles a surface visibly, or is plausibly worth A/B-testing across customers — wrap it in a tunable.

**Files:**
- `frontend/src/tunables.js` — registry. Single source of truth. Add new flags here.
- `frontend/src/contexts/TunablesContext.jsx` — `useTunable(key)` hook + provider (mounted in `App.jsx` inside `AuthProvider`).
- `frontend/src/components/settings/LabSettings.jsx` — auto-generated UI under Settings → Advanced → Lab. New entries appear without code changes.
- `backend/user_settings.py` — `load_user_tunables` / `update_user_tunables` against the `user_settings.tunables` JSONB column (migration `009_user_settings_tunables.sql`).
- `/api/tunables` GET/PUT — endpoints the frontend hits.

**Resolution priority** (highest wins): URL param `?tunables.<key>=on|off|<value>` → per-user row in Supabase → registry default.

**Pattern for adding a tunable:**
```js
// frontend/src/tunables.js
export const TUNABLES = [
  {
    key: 'sidebarV2',
    type: 'bool',                  // 'bool' (default) | 'string' | 'number'
    default: false,                // safe value — usually OFF for new UI
    description: 'New sidebar with sticky nav + 2-line conversation titles.',
    addedOn: '2026-05-17',
    owner: 'sraval',
  },
];
```
```jsx
// In any component:
import { useTunable } from '../tunables';
const sidebarV2 = useTunable('sidebarV2');
return sidebarV2 ? <NewSidebar /> : <OldSidebar />;
```

**Retiring a tunable**: pick the surviving branch, inline it, delete the conditional, then remove the registry entry. Stale user-row values for the removed key are ignored automatically.

**Don't**: leave a tunable on/off for everyone for more than ~2 weeks. Long-lived flags rot into dead code paths. Pick a winner and inline it.

## Common Gotchas

1. **Port Conflicts**: Backend uses 8001 (not 8000). Update `backend/main.py` and `frontend/src/api.js` together.

2. **CORS Errors**: Frontend origins must match `main.py` CORS middleware (localhost:5173 and :3000).

3. **Missing Metadata**: `label_to_model` and `aggregate_rankings` are ephemeral - only in API responses, not stored.

4. **Duplicate Tabs**: Use immutable state updates (spread operator), not mutations. StrictMode runs effects twice.

5. **Search Rate Limits**: DuckDuckGo can rate-limit. Retry logic in `search.py` handles this.

6. **Jina Reader 451 Errors**: Many news sites block AI scrapers. Use Tavily/Brave or set `full_content_results` to 0.

7. **Model Deduplication**: When multiple sources provide same model, use Map-based deduplication preferring direct connections.

8. **Binary Dependencies**: `node_modules` in iCloud can break between Mac architectures. Delete and reinstall.

9. **Custom Endpoint Icons**: Models from custom endpoints may match name patterns (e.g., "claude"). Check `custom:` prefix first.

10. **Settings endpoints are global + auth-gated**: All `/api/settings*`, `/api/models*`, `/api/ollama/tags`, `/api/custom-endpoint/models` now require `Depends(get_current_user)`. The storage is still `data/settings.json` (process-global) — any authed user can mutate prompts/council models for everyone. Migrating to per-user settings is open work.

## Data Flow

```
EssayFlow (topic → intake Q&A → core idea → voice) → essay_sessions row
    ↓
POST /api/conversations/{id}/message/stream  (auth-required, SSE)
    ↓
[Web Search: DuckDuckGo / Tavily / Brave + Jina Reader]  (optional)
    ↓
Pitch race: 4 personas pitch THESIS/LEAD/KEY MOVE in parallel
    ↓
Pitch picker (Flash, ~3s) → SHARED ANGLE prepended to every Stage 1 prompt
    ↓
Stage 1: 4 personas draft in parallel from the shared angle
   each persona has a STRUCTURAL COMMITMENT (long-paragraph / short-paragraph
   / counterargument-first / sensory-first) so the drafts diverge usefully
   prompt = persona + voice_profile_block + student_profile_block
          + library_voice_block + essay_mode_block + word_target_block
          + shared_pitch (prepended)
    ↓
[interim_question(×0–2)]  ←→  user POSTs to /api/intake/answer
    ↓
Spine picker (Flash, ~3s) → picks the strongest Stage 1 draft
    ↓
Stage 2: Critique (parallel) — each member produces CUT/SHARPEN/KEEP/BORROW
   notes against the spine. NOT a ranking.
    ↓
[interim_question(×0–1)]  ←→  user answers
    ↓
[clarification_question(×0–1) — chairman pre-pass; wait up to 25s]
    ↓
Stage 3: Chairman REVISES the spine using the consolidated critiques
   (not a synthesis-from-scratch). Critiques + in_flight_qa_block folded in.
    ↓
Persist:
   - conversations/{id}.json  (stage1, stage2, stage3, metadata)
   - essay_memory  (one durable row per completed essay)
   - user_fact  (fire-and-forget extraction via memory_extraction)
     → maybe_summarize_overflow() folds oldest half if corpus > 8000 chars
```

## Testing & Debugging

```bash
# Check Ollama models
curl http://localhost:11434/api/tags

# Test custom endpoint
curl https://your-endpoint.com/v1/models -H "Authorization: Bearer $API_KEY"

# View logs
# Watch terminal running backend/main.py
```

## Web Search

**Providers**: DuckDuckGo (free), Tavily (API), Brave (API)

**Full Content Fetching**: Jina Reader (`https://r.jina.ai/{url}`) extracts article text for top N results (configurable 0-10, default 3). Falls back to summary if fetch fails or yields <500 chars. 25-second timeout per article, 60-second total search budget.

**Search Query Processing**:
- **Direct** (default): Send exact query to search engine
- **YAKE**: Extract keywords first (useful for long prompts)

## Settings

**UI Sections** (sidebar navigation):
1. **Council**: Per-user council config — 4 persona slots + chairman + per-persona temperature; "I'm Feeling Lucky" randomizer. Persisted to `user_council_config` table.
2. **System Prompts**: Stage 1/2/3 prompts with reset-to-default (kept in `data/settings.json` — global, not per-user).
3. **My Voice**: User voice rules (auto-grow textareas, seeded with `DEFAULT_VOICE_RULES`), reference paragraphs, preferred authors, AI-suggested rules review queue. Persisted to `voice_profiles` table.
4. **What We Know**: Read view of every active `user_fact` grouped by category with per-row Forget button. Summary rows (`source='summary'`) are visually distinct.
5. **Search Providers**: DuckDuckGo, Tavily, Brave + Jina full-content settings.
6. **Backup & Reset**: Import/Export config, reset to defaults.
7. **LLM API Keys** (hidden in hosted mode): only used in self-hosted dev where keys live in `data/settings.json` instead of env vars.

**Auto-Save Behavior**:
- **Credentials auto-save**: API keys and URLs save immediately on successful test
- **Configs require manual save**: Model selections, prompts, temperatures
- UX flow: Test → Success → Auto-save → Clear input → "Settings saved!"

**Temperature Controls**:
- Council Heat: Stage 1 creativity (default: 0.5)
- Chairman Heat: Stage 3 synthesis (default: 0.4)
- Stage 2 Heat: Peer ranking consistency (default: 0.3)

**Rate Limit Warnings**:
- Formula: `(council_members × 2) + 2` requests per council run
- OpenRouter free tier: 20 RPM, 50 requests/day
- Groq: 30 RPM, 14,400 requests/day

**Storage**: `data/settings.json`

## Design Principles

- **Graceful Degradation**: Single model failure doesn't block entire council
- **Transparency**: All raw outputs inspectable via tabs
- **De-anonymization**: Models receive "Response A/B/C", frontend displays real names
- **Progress Indicators**: "X/Y completed" during streaming
- **Provider Flexibility**: Mix cloud, local, and custom endpoints freely

## Code Safety Guidelines

**Communication:**
- NEVER make assumptions when requirements are vague - ask for clarification
- Provide options with pros/cons for different approaches
- Confirm understanding before significant changes

**Code Safety:**
- NEVER use placeholders like `// ...` in edits - this deletes code
- Always provide full content when writing/editing files
- FastAPI: Inject raw `Request` object to access `is_disconnected()`
- React: Use spread operators for immutable state updates (StrictMode runs effects twice)

## Future Enhancements

- Model performance analytics over time
- Export conversations to markdown/PDF
- Custom ranking criteria (beyond accuracy/insight)
- Backend caching for repeated queries
- Multiple custom endpoints support
