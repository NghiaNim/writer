# Changelog

All notable changes to LLM Council Plus will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-05-11

### Removed
- **Legacy execution modes** (`chat_only`, `chat_ranking`) — unreachable from the UI for the entire 0.3.x line. The toggle was never built; the modes only persisted because nothing forced cleanup. Net delete: ~800 LOC.
  - `Stage3.jsx` + `Stage3.css` (its job is done by `FinalEssay`).
  - `Stage1Skeleton` / `Stage2Skeleton` exports (only the legacy branch used them).
  - The entire legacy stage-by-stage rendering branch in `ChatInterface.jsx`.
  - `executionMode` state, `setExecutionMode`, the auto-save effect, and the prop threading through `App.jsx → ChatInterface → AssistantMessageBody`.
  - `execution_mode` field on `SendMessageRequest`, on `UpdateSettingsRequest`, and on `Settings`. Backend always runs all three stages now; old persisted values in `data/settings.json` are silently ignored.
- **Redundant `SUGGESTED_STARTER_RULES`** in `VoiceProfileSettings.jsx` — every starter was already covered by `DEFAULT_VOICE_RULES` seeded on first read.
- **Dead `AVAILABLE_MODELS` list** in `backend/settings.py` (static fallback for a legacy Settings UI; the live OpenRouter catalog drives the picker).
- **Stale "Phase N" comments** throughout the backend — replaced with concrete descriptions of what each block does.

### Added
- **"Restore defaults" button** on the voice-rules editor with an inline two-step confirm. Pulls `GET /api/voice-profile/defaults` and adds any rule the user doesn't already have; never removes or reorders existing rules.

### Changed
- `Stage1.jsx` and `Stage2.jsx` are now used only as raw stage inspectors inside the FinalEssay "Show council notes" disclosure and the aborted-fallback notes.

## [0.3.0] - 2026-05-11

### Added
- **Essay Coach product layer** built on top of the 3-stage council:
  - Smart intake flow (`EssayFlow.jsx`): topic → 3–5 probing questions → 1-paragraph core-idea brief → voice anchor.
  - Per-essay session state in `essay_sessions` (resumable across refresh).
  - Durable essay memory in `essay_memory` (one row per completed essay, with feedback).
- **Supabase auth**: email/password + Google OAuth + JWT refresh. Every user has their own conversations, voice rules, facts, and council config. Backend uses service-role key; RLS policies enforce per-user isolation.
- **Voice profile**: per-user `voice_profiles` row holding rules, reference paragraphs, preferred authors, and an AI-rule review queue. Auto-seeded with ~28 anti-AI-tell **`DEFAULT_VOICE_RULES`** (no em-dashes, no rhetorical-colon noun phrases, no "delve," no false balance, etc.) on first read.
- **Voice library**: read-only scaffold pool of example voices loaded from `voices/*.json`. The council borrows a random voice's rhythm per essay (deterministic per session id).
- **User-fact memory** (`user_fact`): Gemini-Flash extractor reads every completed essay and pulls up to 8 categorized facts (biography / experience / belief / interest / achievement / relationship / reference / general). Facts are injected into every future stage 1 + stage 3 prompt.
- **Interim questions**: while stages 1 and 2 run, the backend emits 1–3 short tailored questions about gaps the drafts hand-waved. Frontend renders them in a gold side panel (`InterimQuestions.jsx`); answers feed the chairman synthesis happening RIGHT NOW and accumulate as durable facts.
- **Chairman clarification ask-back**: right before stage 3, a single Gemini-Flash call decides if one specific question pinned to a vague claim in the drafts would meaningfully improve the essay. If yes, the panel relights with a brighter gold variant and waits up to 25s for an answer.
- **Memory summarization-on-overflow**: when the user's active facts exceed 8000 chars, the oldest half is folded into one `'summary'` fact (Gemini Flash) and the originals are archived (visible in the Memory panel, excluded from prompts).
- **"What We Know" panel** (`Settings → What We Know`): facts grouped by category with per-row Forget button; summary rows visually distinct.
- **Refinement chips + custom refinements**: post-essay dock with surgical, essay-specific suggestions. Custom refinements can be saved as durable voice rules via the review queue.
- **SSE event types**: `interim_question`, `clarification_question` join the existing stage1/stage2/stage3 progress events.

### Changed
- **`load_voice_profile` seeds on first read** so every new user gets the default rules without any signup-time orchestration.
- **`load_recent_user_facts` filters `archived_at IS NULL`** so archived rows stop participating in prompt construction (still queryable for the Memory panel).
- **Stage 3 chairman prompt** now folds an `in_flight_qa_block` into `student_profile_block`. Existing custom prompt templates automatically pick this up — no new placeholder required.
- **`/api/intake/answer`** records skipped questions in the run buffer too, so the chairman wait-loop short-circuits on a user skip instead of timing out.
- **Voice rule editor** now uses an auto-growing `<textarea>` so long rules display fully (previous `<input>` truncated mid-rule).
- **`Settings.jsx`** gains a 7th section: **What We Know**.

### Fixed
- Two stray tables from a prototype migration (`user_profiles`, `brainstorm_drafts`) referenced a non-existent `users(id)` instead of `auth.users(id)`. Migration 007 drops both safely.

### Database
- **Migration 007** (`007_fact_archive_and_cleanup.sql`): drops `user_profiles` + `brainstorm_drafts`; adds `user_fact.archived_at` + `superseded_by` (self-FK); adds `'summary'` source; active-only index.

## [0.2.2] - 2026-02-18

### Fixed
- **Ollama Configuration**: Fixed an issue where the "Local (Ollama)" toggle was disabled even when Ollama was connected (PR #4). Thanks @patrickgamer!

## [0.2.1] - 2026-01-31

### Added
- **Serper.dev Integration**: Google Search via Serper API with 2,500 free queries
- **DuckDuckGo Search Optimization**: Intelligent query processing with intent detection, hybrid web+news search, and relevance reranking
- **Search Settings**: Configurable result count (5-15) and hybrid mode toggle for DuckDuckGo
- **Query Intent Detection**: Automatically detects current events, factual, comparison, and research queries
- **Auto-save Council Config**: Council members and chairman selections now auto-save (no more forgetting to click Save)
- **Council Validation**: Prevent saving incomplete configurations (empty member slots or missing chairman)

### Changed
- **Improved Font Readability**: Switched markdown headers and model names from stylized 'Syne' to readable 'Plus Jakarta Sans'
- **Search Query Processing**: DuckDuckGo now automatically removes conversational fluff and adds temporal context
- **Search Provider Auto-switch**: Testing a search API key now auto-saves and switches to that provider

### Fixed
- YAKE keyword extraction setting now only shows for Tavily/Brave (DuckDuckGo has built-in optimization)
- Font inconsistency between Stage 3 (Chairman) and Stage 1/2 responses
- CORS support for additional frontend port (5174)

## [0.2.0] - 2026-01-31

### Added
- **Mobile Responsiveness**: Full mobile support with hamburger menu, responsive layouts, and touch-friendly UI
- **Chat History Search**: Filter conversations by title in the sidebar
- **Source Validation**: Disable model source toggles when API key not configured with helpful tooltips
- **Version Display**: Show version number in sidebar and settings

### Changed
- **UI Redesign**: New "Council Chamber" dark theme with refined glassmorphism
- **Typography**: Updated font stack (Syne, Plus Jakarta Sans, Source Serif 4, JetBrains Mono)
- **Hero Animations**: Staggered fade-in animations for welcome screen elements

### Fixed
- Auto-cleanup of empty conversations when switching or creating new ones
- Duplicate API route in backend
- Duplicate CSS blocks causing style conflicts
- React key anti-pattern in message list
- Redundant decorator in provider base class

## [0.1.0] - Initial Release

### Added
- 3-stage deliberation system (Individual Responses → Peer Ranking → Chairman Synthesis)
- Multi-provider support: OpenRouter, Ollama, Groq, Direct providers, Custom endpoints
- Web search integration: DuckDuckGo, Tavily, Brave with Jina Reader
- Execution modes: Chat Only, Chat + Ranking, Full Deliberation
- Conversation persistence with JSON storage
- Settings management with import/export
- "I'm Feeling Lucky" random model selection
