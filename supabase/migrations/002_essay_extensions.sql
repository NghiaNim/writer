-- =========================================================================
-- 002_essay_extensions.sql
--
-- Adds per-essay word target + council customization, plus a per-user
-- default council configuration row. Idempotent; safe to re-run.
-- =========================================================================

-- ---------- essay_sessions ----------------------------------------------
-- word_target: optional integer goal (e.g. 250, 500, 650, 1000, custom).
-- council_config: per-essay override. JSON shape:
--   {
--     "personas": [
--       {"key": "architect",       "enabled": true,  "model": "openrouter:..."},
--       {"key": "editor",          "enabled": true,  "model": "openrouter:..."},
--       {"key": "devils_advocate", "enabled": true,  "model": "openrouter:..."},
--       {"key": "voice_guardian",  "enabled": true,  "model": "openrouter:..."}
--     ],
--     "chairman_model": "openrouter:..."
--   }
ALTER TABLE public.essay_sessions
    ADD COLUMN IF NOT EXISTS word_target INT,
    ADD COLUMN IF NOT EXISTS council_config JSONB;

ALTER TABLE public.essay_sessions
    DROP CONSTRAINT IF EXISTS essay_sessions_word_target_range;

ALTER TABLE public.essay_sessions
    ADD CONSTRAINT essay_sessions_word_target_range
    CHECK (word_target IS NULL OR (word_target >= 50 AND word_target <= 5000));


-- ---------- user_council_config -----------------------------------------
-- Per-user default council. One row per user. Same shape as the
-- essay_sessions.council_config JSON above.
CREATE TABLE IF NOT EXISTS public.user_council_config (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    personas JSONB NOT NULL DEFAULT '[]'::jsonb,
    chairman_model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_user_council_config_updated_at
    ON public.user_council_config;
CREATE TRIGGER set_user_council_config_updated_at
    BEFORE UPDATE ON public.user_council_config
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.user_council_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own row" ON public.user_council_config;
CREATE POLICY "own row" ON public.user_council_config
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
