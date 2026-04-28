# Supabase migrations

SQL migrations for the hosted Essay Coach. Apply them in order, then run the
verification script to confirm everything is wired up.

## Migrations

| File | What it does |
| --- | --- |
| `migrations/001_initial.sql` | Creates `voice_profiles`, `essay_memory`, `essay_sessions`, with indexes, `updated_at` triggers, and Row Level Security policies. |
| `migrations/002_essay_extensions.sql` | Adds `word_target` + `council_config` to `essay_sessions`, and creates `user_council_config` (per-user default council) with RLS. |
| `migrations/003_voice_library_and_review_queue.sql` | Creates `voice_library` (read-only voice scaffolding pool); adds `pending_suggestions` + `preferred_authors` to `voice_profiles`; adds `voice_library_id`, `audience`, `intake_questions`, `core_idea` to `essay_sessions`. After applying, run `uv run python -m backend.scripts.seed_voice_library` to populate `voice_library` from the `voices/` folder. |

All migrations are idempotent: re-running them is safe.

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
