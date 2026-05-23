-- =========================================================================
-- 010_essay_session_step.sql
--
-- Adds a `step` column to essay_sessions so we can persist the user's
-- position in the intake flow and resume them on page reload. Pairs with
-- the new "Drafts in progress" sidebar that lists unfinished sessions
-- with the step they were on.
--
-- Allowed step values mirror the frontend's STEP_ORDER:
--   topic | brainstorm | draft | questions | core_idea | timeline | voice
--
-- 'brainstorm' and 'draft' are alternate lanes off Step 1; 'voice' is the
-- final pre-flight step. NULL is permitted for legacy rows.
-- =========================================================================

ALTER TABLE public.essay_sessions
    ADD COLUMN IF NOT EXISTS step TEXT;

ALTER TABLE public.essay_sessions
    DROP CONSTRAINT IF EXISTS essay_sessions_step_check;

ALTER TABLE public.essay_sessions
    ADD CONSTRAINT essay_sessions_step_check
    CHECK (
        step IS NULL OR step IN (
            'topic',
            'brainstorm',
            'draft',
            'questions',
            'core_idea',
            'timeline',
            'voice'
        )
    );

-- The sidebar's "Drafts in progress" query filters by user_id + status
-- and orders by updated_at desc. The existing (user_id, updated_at)
-- index would suffice on its own but adding status into the predicate
-- avoids a full-row scan for users with many completed essays.
CREATE INDEX IF NOT EXISTS essay_sessions_in_progress_idx
    ON public.essay_sessions (user_id, updated_at DESC)
    WHERE status = 'in_progress';
