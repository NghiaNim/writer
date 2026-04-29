-- =========================================================================
-- 004_essay_memory_and_user_facts.sql
--
-- Links essay_sessions to conversations, extends essay_memory for durable
-- storage + feedback, adds user_fact for student-specific facts (Phase C).
-- Idempotent where possible.
-- =========================================================================

-- ---------- essay_sessions: link to file-backed conversation ------------
ALTER TABLE public.essay_sessions
    ADD COLUMN IF NOT EXISTS conversation_id TEXT;

CREATE INDEX IF NOT EXISTS essay_sessions_conversation_id_idx
    ON public.essay_sessions (conversation_id)
    WHERE conversation_id IS NOT NULL;


-- ---------- essay_memory: correlation + feedback -------------------------
ALTER TABLE public.essay_memory
    ADD COLUMN IF NOT EXISTS conversation_id TEXT,
    ADD COLUMN IF NOT EXISTS session_id UUID,
    ADD COLUMN IF NOT EXISTS essay_mode TEXT,
    ADD COLUMN IF NOT EXISTS word_target INT,
    ADD COLUMN IF NOT EXISTS feedback_rating INT,
    ADD COLUMN IF NOT EXISTS feedback_text TEXT,
    ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ;

-- Optional FK from essay_memory.session_id -> essay_sessions (same user)
ALTER TABLE public.essay_memory
    DROP CONSTRAINT IF EXISTS essay_memory_session_fk;
ALTER TABLE public.essay_memory
    ADD CONSTRAINT essay_memory_session_fk
    FOREIGN KEY (session_id) REFERENCES public.essay_sessions (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS essay_memory_conversation_idx
    ON public.essay_memory (user_id, conversation_id)
    WHERE conversation_id IS NOT NULL;

-- One durable row per completed essay per conversation (re-run updates).
CREATE UNIQUE INDEX IF NOT EXISTS essay_memory_user_conversation_uniq
    ON public.essay_memory (user_id, conversation_id)
    WHERE conversation_id IS NOT NULL;


-- ---------- user_fact: long-lived facts about the student ---------------
CREATE TABLE IF NOT EXISTS public.user_fact (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    fact_text   TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT user_fact_source_check CHECK (
        source IN ('manual', 'intake', 'chat', 'feedback')
    )
);

CREATE INDEX IF NOT EXISTS user_fact_user_recent_idx
    ON public.user_fact (user_id, created_at DESC);

ALTER TABLE public.user_fact ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own rows" ON public.user_fact;
CREATE POLICY "own rows" ON public.user_fact
    FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
