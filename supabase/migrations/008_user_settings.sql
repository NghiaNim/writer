-- =========================================================================
-- 008_user_settings.sql
--
-- Per-user override row for the small set of fields that used to live
-- globally in data/settings.json:
--   - Stage 1/2/3 system prompts
--   - Council / chairman / stage 2 temperatures
--   - Search provider + search prefs
--
-- NULL columns mean "use the operator-wide default" (whatever
-- backend/settings.py returns). A row is upserted on first PUT.
-- API keys are NOT here — those are env-only (see SECRET_FIELDS).
--
-- Idempotent.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.user_settings (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Prompts (NULL = use global default)
    stage1_prompt TEXT,
    stage2_prompt TEXT,
    stage3_prompt TEXT,

    -- Temperatures (NULL = use global default)
    council_temperature   DOUBLE PRECISION,
    chairman_temperature  DOUBLE PRECISION,
    stage2_temperature    DOUBLE PRECISION,

    -- Search prefs (NULL = use global default)
    search_provider           TEXT,
    search_keyword_extraction TEXT,
    search_result_count       INTEGER,
    search_hybrid_mode        BOOLEAN,
    full_content_results      INTEGER,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Touch updated_at on every UPDATE.
CREATE OR REPLACE FUNCTION public.user_settings_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_settings_touch_updated_at ON public.user_settings;
CREATE TRIGGER user_settings_touch_updated_at
    BEFORE UPDATE ON public.user_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.user_settings_touch_updated_at();

-- ---------- RLS: belt-and-suspenders against the anon key ---------------
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_settings_select_own" ON public.user_settings;
CREATE POLICY "user_settings_select_own"
    ON public.user_settings FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_settings_insert_own" ON public.user_settings;
CREATE POLICY "user_settings_insert_own"
    ON public.user_settings FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_settings_update_own" ON public.user_settings;
CREATE POLICY "user_settings_update_own"
    ON public.user_settings FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_settings_delete_own" ON public.user_settings;
CREATE POLICY "user_settings_delete_own"
    ON public.user_settings FOR DELETE
    USING (auth.uid() = user_id);

COMMENT ON TABLE public.user_settings IS
    'Per-user overrides for prompts, temperatures, and search prefs. '
    'NULL columns fall back to backend/settings.py operator-wide defaults.';
