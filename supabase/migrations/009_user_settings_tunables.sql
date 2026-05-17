-- =========================================================================
-- 009_user_settings_tunables.sql
--
-- Per-user tunables (feature flags) live on user_settings as a single JSONB
-- column. Each key maps to a tunable's `key` field in
-- frontend/src/tunables.js. Missing keys fall back to the registry default.
--
-- Why a JSONB blob instead of a column-per-flag: tunables come and go
-- frequently (most are short-lived A/B experiments). A JSONB column lets us
-- add and retire flags without writing a migration each time. The registry
-- in the frontend is the source of truth for which keys are valid; the DB
-- just stores overrides.
--
-- Shape:
--   { "newSidebar": true, "chairmanModelPicker": false }
--
-- NULL or missing column = no overrides; every tunable uses its registry
-- default.
--
-- Idempotent.
-- =========================================================================

ALTER TABLE public.user_settings
    ADD COLUMN IF NOT EXISTS tunables JSONB;

COMMENT ON COLUMN public.user_settings.tunables IS
    'Per-user feature-flag overrides. Keys correspond to entries in '
    'frontend/src/tunables.js. Missing keys fall back to the registry default.';
