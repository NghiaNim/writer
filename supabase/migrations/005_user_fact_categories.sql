-- =========================================================================
-- 005_user_fact_categories.sql
--
-- Extends user_fact for auto-extracted essay memory:
--   * category column (biography / experience / belief / interest /
--     achievement / relationship / reference / general) for filtered
--     retrieval and grouped display in the Memory UI.
--   * source_essay_id (optional FK to essay_memory) for traceability —
--     lets us delete or refresh facts when an essay is re-run.
--   * 'essay' added to the source check so the auto-extractor can write.
--
-- Idempotent.
-- =========================================================================

-- ---------- new columns --------------------------------------------------
ALTER TABLE public.user_fact
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS source_essay_id UUID;

-- ---------- category check (drop & re-add for idempotency) ---------------
ALTER TABLE public.user_fact
    DROP CONSTRAINT IF EXISTS user_fact_category_check;
ALTER TABLE public.user_fact
    ADD CONSTRAINT user_fact_category_check CHECK (
        category IN (
            'biography',    -- where they're from, schools, jobs, family
            'experience',   -- things they've done / lived through
            'belief',       -- values, opinions, what they argue for
            'interest',     -- subjects / fields they care about
            'achievement',  -- awards, accomplishments, milestones
            'relationship', -- people who matter (mentors, family, friends)
            'reference',    -- writers/works they admire or cite
            'general'       -- catch-all
        )
    );

-- ---------- relax source check to allow 'essay' --------------------------
ALTER TABLE public.user_fact
    DROP CONSTRAINT IF EXISTS user_fact_source_check;
ALTER TABLE public.user_fact
    ADD CONSTRAINT user_fact_source_check CHECK (
        source IN ('manual', 'intake', 'chat', 'feedback', 'essay')
    );

-- ---------- FK to essay_memory (nullable, ON DELETE SET NULL) ------------
ALTER TABLE public.user_fact
    DROP CONSTRAINT IF EXISTS user_fact_source_essay_fk;
ALTER TABLE public.user_fact
    ADD CONSTRAINT user_fact_source_essay_fk
    FOREIGN KEY (source_essay_id)
    REFERENCES public.essay_memory (id)
    ON DELETE SET NULL;

-- ---------- indexes ------------------------------------------------------
-- Filtered retrieval by category (e.g. always inject 'biography' + topic-relevant cats).
CREATE INDEX IF NOT EXISTS user_fact_user_category_idx
    ON public.user_fact (user_id, category, created_at DESC);

-- Lookup by source essay (used when an essay is re-run to refresh its facts).
CREATE INDEX IF NOT EXISTS user_fact_source_essay_idx
    ON public.user_fact (source_essay_id)
    WHERE source_essay_id IS NOT NULL;
