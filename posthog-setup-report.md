<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into your FastAPI backend.

## Summary of changes

**`backend/main.py`**
- Added `import posthog` and `from contextlib import asynccontextmanager`
- Added a `lifespan` context manager that initializes PostHog on startup (`posthog.api_key`, `posthog.host`, `posthog.enable_exception_autocapture`) and flushes events on shutdown
- Updated `app = FastAPI(...)` to use `lifespan=lifespan`
- Added event captures in `send_message_stream` (council lifecycle), `api_save_voice_profile`, and `api_intake_questions`

**`backend/auth.py`**
- Added `import posthog`
- Added `user_signed_up` capture on successful account creation
- Added `user_logged_in` capture on successful password login

**`backend/.env`**
- Added `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` (loaded automatically via the existing `config.py` `load_dotenv`)

**`pyproject.toml`** (via `uv add posthog`)
- Added `posthog>=7.13.1` as a dependency

## Events instrumented

| Event | Description | File |
|-------|-------------|------|
| `user_signed_up` | A new user successfully registered an account | `backend/auth.py` |
| `user_logged_in` | A user successfully authenticated with email/password | `backend/auth.py` |
| `council_started` | User submitted a message and council deliberation began | `backend/main.py` |
| `council_completed` | Council deliberation finished successfully for all requested stages | `backend/main.py` |
| `council_error` | Council deliberation failed (all models returned errors) | `backend/main.py` |
| `web_search_performed` | User triggered a web search as context for a council query | `backend/main.py` |
| `essay_saved` | A full deliberation essay result was persisted to long-term memory | `backend/main.py` |
| `voice_profile_saved` | User saved their writing voice profile | `backend/main.py` |
| `intake_started` | User initiated the essay intake flow by requesting intake questions | `backend/main.py` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard**: [Analytics basics](https://us.posthog.com/project/403295/dashboard/1526404)
- [User Signups & Logins over time](https://us.posthog.com/project/403295/insights/Q6u7nWAj) — daily acquisition trend
- [Council completion funnel](https://us.posthog.com/project/403295/insights/UhHoaXpZ) — drop-off from start → complete
- [Essay completion funnel](https://us.posthog.com/project/403295/insights/QjyQoFmd) — intake → council → essay saved
- [Council usage by execution mode](https://us.posthog.com/project/403295/insights/nt3sdU8s) — which deliberation depth users prefer
- [Council error rate](https://us.posthog.com/project/403295/insights/jrQwbSIx) — completed vs errored sessions over time

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-fastapi/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
