-- =========================================================================
-- 007_fact_archive_and_cleanup.sql
--
-- Two things:
--   1. Drop the two stray tables (user_profiles, brainstorm_drafts) that an
--      earlier prototype migration created. Their FKs pointed at a non-
--      existent users(id) and they duplicated user_fact + essay_sessions.
--   2. Extend user_fact with `archived_at` + `superseded_by` so we can fold
--      the oldest active facts into a single 'summary' fact when the corpus
--      grows past the prompt budget — without ever losing the originals.
--
-- Idempotent.
-- =========================================================================

-- ---------- 1. drop the stray tables ------------------------------------
DROP TABLE IF EXISTS public.brainstorm_drafts;
DROP TABLE IF EXISTS public.user_profiles;


-- ---------- 2. user_fact archive columns --------------------------------
ALTER TABLE public.user_fact
    ADD COLUMN IF NOT EXISTS archived_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS superseded_by UUID;

-- self-FK so deleting a summary nulls out the supersedes pointer rather than
-- cascading the originals away.
ALTER TABLE public.user_fact
    DROP CONSTRAINT IF EXISTS user_fact_superseded_by_fk;
ALTER TABLE public.user_fact
    ADD CONSTRAINT user_fact_superseded_by_fk
    FOREIGN KEY (superseded_by)
    REFERENCES public.user_fact (id)
    ON DELETE SET NULL;

-- Allow 'summary' as a synthetic source for overflow-summarization rows.
ALTER TABLE public.user_fact
    DROP CONSTRAINT IF EXISTS user_fact_source_check;
ALTER TABLE public.user_fact
    ADD CONSTRAINT user_fact_source_check CHECK (
        source IN ('manual', 'intake', 'chat', 'feedback', 'essay', 'summary')
    );

-- Active-only index so the hot-path loader (load_recent_user_facts) can scan
-- just the live rows. Archived facts remain in the table for full recall.
CREATE INDEX IF NOT EXISTS user_fact_user_active_idx
    ON public.user_fact (user_id, created_at DESC)
    WHERE archived_at IS NULL;
