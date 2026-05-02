"""Supabase-backed storage for conversations.

Conversations live in the `public.conversations` table (migration 006). Each
function takes a `user_id` and scopes its query so a user can only ever see
or mutate their own rows. The service-role client bypasses RLS, so app-level
scoping is the actual enforcement — RLS policies in the migration are
belt-and-suspenders against any future direct anon-key access.

The dict shapes returned here match what the frontend already consumes:

    list_conversations() -> [{id, created_at, title, message_count}, ...]
    get_conversation()   -> {id, created_at, title, messages: [...]}

Mutating helpers (add_user_message / add_assistant_message / etc.) read the
current row, append to the in-memory `messages` list, and write the whole
list back. That mirrors the previous file-based behavior — concurrent writes
to the same conversation last-write-wins, which matches the prior semantics.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .supabase_client import get_supabase

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _row_to_full(row: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce a DB row into the shape the API/frontend expects for a full conversation."""
    return {
        "id": str(row["id"]),
        "created_at": str(row["created_at"]),
        "title": row.get("title") or "New Conversation",
        "messages": row.get("messages") or [],
    }


def _row_to_meta(row: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce a DB row into the metadata shape used by the sidebar list."""
    messages = row.get("messages") or []
    return {
        "id": str(row["id"]),
        "created_at": str(row["created_at"]),
        "title": row.get("title") or "New Conversation",
        "message_count": len(messages),
    }


def _fetch_row(conversation_id: str, user_id: str) -> Optional[Dict[str, Any]]:
    """Read a single conversation row, scoped to the owner."""
    sb = get_supabase()
    res = (
        sb.table("conversations")
        .select("id, user_id, title, messages, created_at, updated_at")
        .eq("id", conversation_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    if not res.data:
        return None
    return res.data[0]


def _write_messages(conversation_id: str, user_id: str, messages: List[Dict[str, Any]]) -> None:
    """Persist the full messages array for a conversation."""
    sb = get_supabase()
    sb.table("conversations").update({"messages": messages}).eq("id", conversation_id).eq(
        "user_id", user_id
    ).execute()


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def create_conversation(user_id: str, conversation_id: Optional[str] = None) -> Dict[str, Any]:
    """Create a new conversation owned by `user_id`.

    `conversation_id` is optional — if omitted, the DB assigns one.
    """
    sb = get_supabase()
    payload: Dict[str, Any] = {
        "user_id": user_id,
        "title": "New Conversation",
        "messages": [],
    }
    if conversation_id:
        payload["id"] = conversation_id
    res = sb.table("conversations").insert(payload).execute()
    if not res.data:
        raise RuntimeError("Failed to create conversation row")
    return _row_to_full(res.data[0])


def get_conversation(conversation_id: str, user_id: str) -> Optional[Dict[str, Any]]:
    """Load a conversation owned by `user_id`. Returns None if missing."""
    row = _fetch_row(conversation_id, user_id)
    if row is None:
        return None
    return _row_to_full(row)


def list_conversations(user_id: str) -> List[Dict[str, Any]]:
    """List all conversations for a user, newest first, metadata only."""
    sb = get_supabase()
    res = (
        sb.table("conversations")
        .select("id, title, messages, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return [_row_to_meta(r) for r in (res.data or [])]


def delete_conversation(conversation_id: str, user_id: str) -> bool:
    """Delete a conversation. Returns True if a row was removed."""
    sb = get_supabase()
    res = (
        sb.table("conversations")
        .delete()
        .eq("id", conversation_id)
        .eq("user_id", user_id)
        .execute()
    )
    return bool(res.data)


def update_conversation_title(conversation_id: str, user_id: str, title: str) -> None:
    sb = get_supabase()
    sb.table("conversations").update({"title": title}).eq("id", conversation_id).eq(
        "user_id", user_id
    ).execute()


# ---------------------------------------------------------------------------
# Message append helpers
# ---------------------------------------------------------------------------


def add_user_message(conversation_id: str, user_id: str, content: str) -> None:
    row = _fetch_row(conversation_id, user_id)
    if row is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    messages = row.get("messages") or []
    messages.append({"role": "user", "content": content})
    _write_messages(conversation_id, user_id, messages)


def add_assistant_message(
    conversation_id: str,
    user_id: str,
    stage1: List[Dict[str, Any]],
    stage2: Optional[List[Dict[str, Any]]] = None,
    stage3: Optional[Dict[str, Any]] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    row = _fetch_row(conversation_id, user_id)
    if row is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    messages = row.get("messages") or []

    message: Dict[str, Any] = {
        "role": "assistant",
        "stage1": stage1,
    }
    if stage2 is not None:
        message["stage2"] = stage2
    if stage3 is not None:
        message["stage3"] = stage3
    if metadata:
        message["metadata"] = metadata

    messages.append(message)
    _write_messages(conversation_id, user_id, messages)


def add_error_message(conversation_id: str, user_id: str, error_text: str) -> None:
    row = _fetch_row(conversation_id, user_id)
    if row is None:
        raise ValueError(f"Conversation {conversation_id} not found")
    messages = row.get("messages") or []
    messages.append(
        {
            "role": "assistant",
            "content": None,
            "error": error_text,
            "stage1": [],
            "stage2": [],
            "stage3": None,
        }
    )
    _write_messages(conversation_id, user_id, messages)
