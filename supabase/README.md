# Supabase migrations

SQL migrations for the hosted Essay Coach. Apply them in order, then run the
verification script to confirm everything is wired up.

## Migrations

| File | What it does |
| --- | --- |
| `migrations/001_initial.sql` | Creates `voice_profiles`, `essay_memory`, `essay_sessions`, with indexes, `updated_at` triggers, and Row Level Security policies. All FKs to `auth.users(id)`. |
| `migrations/002_essay_extensions.sql` | Adds `word_target` + `council_config` to `essay_sessions`; creates `user_council_config` (per-user default council) with RLS. |
| `migrations/003_voice_library_and_review_queue.sql` | Creates `voice_library` (read-only voice scaffolding pool); adds `pending_suggestions` + `preferred_authors` to `voice_profiles`; adds `voice_library_id`, `audience`, `intake_questions`, `core_idea` to `essay_sessions`. After applying, run `uv run python -m backend.scripts.seed_voice_library` to populate `voice_library` from the `voices/` folder. |
| `migrations/004_essay_memory_and_user_facts.sql` | Links `essay_sessions` ↔ conversation files via `conversation_id`; adds feedback columns to `essay_memory`; creates the `user_fact` table for durable per-user facts with RLS. |
| `migrations/005_user_fact_categories.sql` | Adds `category` (biography / experience / belief / interest / achievement / relationship / reference / general) and `source_essay_id` FK to `user_fact`; relaxes source check to allow `'essay'`. |
| `migrations/006_conversations.sql` | Creates the `conversations` table for per-user chat history JSONB with RLS. |
| `migrations/007_fact_archive_and_cleanup.sql` | Drops stray `user_profiles` + `brainstorm_drafts` from a prototype migration (their FKs pointed at a non-existent `users(id)`); adds `user_fact.archived_at` + `superseded_by` (self-FK) for summarization-on-overflow; adds `'summary'` source; active-only index. |
| `migrations/008_user_settings.sql` | Creates `user_settings` for per-user overrides of prompts, temperatures, and search prefs that used to live globally in `data/settings.json` (where one user could clobber every other user's values). NULL columns fall back to the operator-wide defaults. RLS on `auth.uid() = user_id`. |

All migrations are idempotent: re-running them is safe.

> **Never reference `users(id)`** — every table FKs to `auth.users(id)`. If you
> see a migration referencing a bare `users(id)`, it came from a different
> codebase and won't work here.

## Applying a migration (Supabase dashboard)

1. Open the [Supabase dashboard](https://app.supabase.com/) for this project.
2. Sidebar → **SQL Editor** → **New query**.
3. Paste the contents of the migration file (e.g. `migrations/001_initial.sql`).
4. Click **Run**. You should see "Success. No rows returned."

## Verifying the schema

After applying the migration, run the verification script from the project
root. It exercises every table — insert, select, update, delete — using a
temporary test user it creates and cleans up afterwards.

```bash
uv run python -m backend.scripts.verify_supabase_schema
```

Expected output ends with `OK — schema verified.` Any failure prints the
specific table and operation that broke.

## What this gives you

* Every row is owned by a `user_id` that references `auth.users`.
* `ON DELETE CASCADE` means deleting a Supabase auth user wipes their data.
* Row Level Security blocks access via the anon key — only the service-role
  key (used by the FastAPI backend) can read/write across users, and the
  backend always scopes queries by the JWT-validated `user_id`.
* `updated_at` is auto-maintained on `voice_profiles` and `essay_sessions`
  via a shared trigger function `public.set_updated_at()`.
