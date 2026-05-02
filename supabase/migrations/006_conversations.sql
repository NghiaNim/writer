-- =========================================================================
-- 006_conversations.sql
--
-- Move chat conversations from local file storage (backend/data/*.json) to
-- Supabase so they survive Render restarts and are properly scoped per user.
--
-- Schema mirrors the previous file-backed shape:
--   { id, created_at, title, messages: [...] }
-- with `messages` stored as JSONB so the existing append-style writes from
-- backend/storage.py continue to work without flattening into rows.
--
-- IDs were string UUIDs in the file layout; we keep that here as native UUID.
-- existing essay_sessions.conversation_id and essay_memory.conversation_id
-- columns are TEXT — they store UUID strings, so values continue to match.
--
-- Idempotent.
-- =========================================================================

-- ---------- table -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New Conversation',
    messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- indexes -----------------------------------------------------
CREATE INDEX IF NOT EXISTS conversations_user_recent_idx
    ON public.conversations (user_id, created_at DESC);

-- ---------- updated_at trigger ------------------------------------------
CREATE OR REPLACE FUNCTION public.conversations_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_updated_at ON public.conversations;
CREATE TRIGGER conversations_updated_at
    BEFORE UPDATE ON public.conversations
    FOR EACH ROW
    EXECUTE FUNCTION public.conversations_set_updated_at();

-- ---------- RLS ---------------------------------------------------------
-- The backend uses the service-role key, which bypasses RLS. Policies here
-- are belt-and-suspenders against any future direct anon-key access.
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversations_owner_select ON public.conversations;
CREATE POLICY conversations_owner_select
    ON public.conversations FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS conversations_owner_insert ON public.conversations;
CREATE POLICY conversations_owner_insert
    ON public.conversations FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS conversations_owner_update ON public.conversations;
CREATE POLICY conversations_owner_update
    ON public.conversations FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS conversations_owner_delete ON public.conversations;
CREATE POLICY conversations_owner_delete
    ON public.conversations FOR DELETE
    USING (auth.uid() = user_id);
