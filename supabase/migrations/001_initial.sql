-- =============================================================================
-- Phase 2: Initial schema for hosted Essay Coach
--
-- Three per-user tables:
--   voice_profiles   one row per (user_id, essay_type)
--   essay_memory     one row per completed essay
--   essay_sessions   one row per in-progress 3-step input flow
--
-- Notes:
--   * The backend authenticates with the SERVICE ROLE key, which bypasses RLS.
--     We always scope queries by the validated user_id in app code. The RLS
--     policies are belt-and-suspenders against direct anon-key access.
--   * Idempotent: safe to re-run (uses IF NOT EXISTS / DROP IF EXISTS).
--   * gen_random_uuid() comes from pgcrypto, which Supabase enables by default.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- voice_profiles
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.voice_profiles (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    essay_type           TEXT NOT NULL DEFAULT 'general',
    rules                JSONB NOT NULL DEFAULT '[]'::jsonb,
    reference_paragraphs JSONB NOT NULL DEFAULT '[]'::jsonb,
    inferred_style       TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, essay_type)
);

CREATE INDEX IF NOT EXISTS voice_profiles_user_id_idx
    ON public.voice_profiles (user_id);


-- -----------------------------------------------------------------------------
-- essay_memory
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.essay_memory (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    topic           TEXT NOT NULL,
    so_what_answer  TEXT,
    essay_type      TEXT,
    core_claim      TEXT,
    summary         TEXT,
    full_essay      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS essay_memory_user_recent_idx
    ON public.essay_memory (user_id, created_at DESC);


-- -----------------------------------------------------------------------------
-- essay_sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.essay_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    topic           TEXT,
    so_what_answer  TEXT,
    essay_type      TEXT,
    path            TEXT CHECK (path IN ('interactive', 'draft')),
    conversation    JSONB NOT NULL DEFAULT '[]'::jsonb,
    draft           TEXT,
    status          TEXT NOT NULL DEFAULT 'in_progress',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS essay_sessions_user_recent_idx
    ON public.essay_sessions (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS essay_sessions_user_status_idx
    ON public.essay_sessions (user_id, status);


-- -----------------------------------------------------------------------------
-- updated_at trigger (shared between voice_profiles and essay_sessions)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS voice_profiles_set_updated_at ON public.voice_profiles;
CREATE TRIGGER voice_profiles_set_updated_at
    BEFORE UPDATE ON public.voice_profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS essay_sessions_set_updated_at ON public.essay_sessions;
CREATE TRIGGER essay_sessions_set_updated_at
    BEFORE UPDATE ON public.essay_sessions
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- -----------------------------------------------------------------------------
-- Row Level Security: each user can only see / write their own rows
-- -----------------------------------------------------------------------------
ALTER TABLE public.voice_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.essay_memory   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.essay_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own rows" ON public.voice_profiles;
CREATE POLICY "own rows" ON public.voice_profiles
    FOR ALL
    USING      (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own rows" ON public.essay_memory;
CREATE POLICY "own rows" ON public.essay_memory
    FOR ALL
    USING      (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own rows" ON public.essay_sessions;
CREATE POLICY "own rows" ON public.essay_sessions
    FOR ALL
    USING      (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
