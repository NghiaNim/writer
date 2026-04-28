-- =========================================================================
-- 003_voice_library_and_review_queue.sql
--
-- Three independent additions, all idempotent:
--
--   1. public.voice_library
--      A read-only-to-users pool of example voices. Populated by
--      backend/scripts/seed_voice_library.py from the voices/*.json files.
--      Used internally as creative scaffolding for the Voice Guardian and
--      Chairman prompts; users never see its contents directly.
--
--   2. voice_profiles.pending_suggestions, voice_profiles.preferred_authors
--      The review queue for AI-suggested rules and the "authors I admire"
--      list captured during the new intake flow.
--
--   3. essay_sessions.voice_library_id
--      Records which library voice was used to scaffold a given essay run,
--      so re-runs of the same session reuse the same anchor and an admin
--      audit can trace voice choices.
-- =========================================================================


-- ---------- voice_library ------------------------------------------------
CREATE TABLE IF NOT EXISTS public.voice_library (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_file                 TEXT NOT NULL UNIQUE,
    prompt                      TEXT,
    essay_text                  TEXT NOT NULL,
    persona_prompt              TEXT,
    tone                        TEXT,
    sentence_style              TEXT,
    vocabulary_level            TEXT,
    structural_patterns         TEXT,
    distinctive_moves           JSONB NOT NULL DEFAULT '[]'::jsonb,
    themes_and_preoccupations   JSONB NOT NULL DEFAULT '[]'::jsonb,
    self_presentation           TEXT,
    cultural_or_contextual_markers TEXT,
    avoid_in_imitation          JSONB NOT NULL DEFAULT '[]'::jsonb,
    sample_sentence             TEXT,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Read-only to users via RLS; the backend uses the service role to seed
-- and to read, so RLS is belt-and-suspenders against direct anon access.
ALTER TABLE public.voice_library ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anyone can read" ON public.voice_library;
CREATE POLICY "anyone can read" ON public.voice_library
    FOR SELECT
    USING (true);
-- No INSERT/UPDATE/DELETE policies → only service role can write.


-- ---------- voice_profiles review queue ----------------------------------
-- pending_suggestions JSON shape:
--   [
--     {"id": "uuid",         -- client-generated (or server-generated on insert)
--      "rule": "no em-dashes",
--      "source": "reference_paragraphs" | "library_voice" | "user",
--      "created_at": "2026-04-28T..."}
--   ]
ALTER TABLE public.voice_profiles
    ADD COLUMN IF NOT EXISTS pending_suggestions JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS preferred_authors   JSONB NOT NULL DEFAULT '[]'::jsonb;


-- ---------- essay_sessions audit ----------------------------------------
ALTER TABLE public.essay_sessions
    ADD COLUMN IF NOT EXISTS voice_library_id UUID
        REFERENCES public.voice_library(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS audience          TEXT,
    ADD COLUMN IF NOT EXISTS intake_questions  JSONB,
    ADD COLUMN IF NOT EXISTS core_idea         TEXT;

CREATE INDEX IF NOT EXISTS essay_sessions_voice_library_idx
    ON public.essay_sessions (voice_library_id);
