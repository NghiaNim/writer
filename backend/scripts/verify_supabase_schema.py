"""Verify the Phase 2 Supabase schema is in place and working.

Run from project root after applying `supabase/migrations/001_initial.sql`:

    uv run python -m backend.scripts.verify_supabase_schema

What this does:
    1. Creates a throwaway test user via the admin API.
    2. Inserts, selects, updates, and deletes a row in each of the three tables.
    3. Verifies the `updated_at` triggers actually update the column.
    4. Deletes the test user (which CASCADE-deletes any leftover rows).

If any step fails, the test user is still cleaned up, and the failing
operation is printed with full traceback. Exits non-zero on failure.
"""

from __future__ import annotations

import sys
import time
import traceback
import uuid
from typing import Optional

from ..supabase_client import get_supabase


PASS = "  OK"
FAIL_PREFIX = "  FAIL: "


def step(label: str) -> None:
    print(f"\n--- {label}")


def ok(msg: str) -> None:
    print(f"{PASS}  {msg}")


def fail(msg: str) -> None:
    print(f"{FAIL_PREFIX}{msg}")


def main() -> int:
    supabase = get_supabase()

    test_email = f"schema-verify-{int(time.time())}-{uuid.uuid4().hex[:6]}@example.org"
    test_password = "schema-verify-pass-123"
    user_id: Optional[str] = None
    failures: list[str] = []

    try:
        step(f"Creating throwaway test user ({test_email})")
        created = supabase.auth.admin.create_user(
            {
                "email": test_email,
                "password": test_password,
                "email_confirm": True,
            }
        )
        user_id = str(created.user.id)
        ok(f"user_id = {user_id}")

        # ------------------------------------------------------------------
        # voice_profiles
        # ------------------------------------------------------------------
        step("voice_profiles: insert / select / update / unique constraint")
        try:
            inserted = (
                supabase.table("voice_profiles")
                .insert(
                    {
                        "user_id": user_id,
                        "essay_type": "general",
                        "rules": ["No em-dashes"],
                        "reference_paragraphs": ["Sample paragraph."],
                        "inferred_style": "dry, concrete",
                    }
                )
                .execute()
            )
            assert inserted.data, "insert returned no rows"
            row = inserted.data[0]
            assert row["rules"] == ["No em-dashes"], "rules JSONB roundtrip failed"
            ok("insert + JSONB roundtrip")

            initial_updated_at = row["updated_at"]
            time.sleep(1.1)  # give the trigger something to detect

            updated = (
                supabase.table("voice_profiles")
                .update({"inferred_style": "dry, concrete, opinionated"})
                .eq("id", row["id"])
                .execute()
            )
            assert updated.data, "update returned no rows"
            new_updated_at = updated.data[0]["updated_at"]
            assert new_updated_at != initial_updated_at, (
                f"updated_at trigger did not fire "
                f"(before={initial_updated_at}, after={new_updated_at})"
            )
            ok("update + updated_at trigger")

            try:
                supabase.table("voice_profiles").insert(
                    {"user_id": user_id, "essay_type": "general"}
                ).execute()
                fail("UNIQUE(user_id, essay_type) was NOT enforced — duplicate insert succeeded")
                failures.append("voice_profiles unique constraint")
            except Exception:
                ok("UNIQUE(user_id, essay_type) enforced")
        except Exception as e:
            fail(f"voice_profiles: {e}")
            traceback.print_exc()
            failures.append("voice_profiles")

        # ------------------------------------------------------------------
        # essay_memory
        # ------------------------------------------------------------------
        step("essay_memory: insert / list newest-first")
        try:
            row1 = (
                supabase.table("essay_memory")
                .insert(
                    {
                        "user_id": user_id,
                        "topic": "Why remote work makes cities worse",
                        "so_what_answer": "Density compounds.",
                        "essay_type": "general",
                        "core_claim": "Cities are positive-sum infrastructure.",
                        "summary": "..." ,
                        "full_essay": "Full text goes here.",
                    }
                )
                .execute()
            )
            assert row1.data, "first insert returned no rows"

            time.sleep(0.05)
            row2 = (
                supabase.table("essay_memory")
                .insert(
                    {
                        "user_id": user_id,
                        "topic": "Second essay",
                    }
                )
                .execute()
            )
            assert row2.data, "second insert returned no rows"

            listed = (
                supabase.table("essay_memory")
                .select("id, topic, created_at")
                .eq("user_id", user_id)
                .order("created_at", desc=True)
                .execute()
            )
            assert len(listed.data) == 2, f"expected 2 rows, got {len(listed.data)}"
            assert listed.data[0]["topic"] == "Second essay", (
                "newest-first ordering not honored"
            )
            ok(f"insert + list newest-first ({len(listed.data)} rows)")
        except Exception as e:
            fail(f"essay_memory: {e}")
            traceback.print_exc()
            failures.append("essay_memory")

        # ------------------------------------------------------------------
        # essay_sessions
        # ------------------------------------------------------------------
        step("essay_sessions: insert / path CHECK / updated_at trigger")
        try:
            session = (
                supabase.table("essay_sessions")
                .insert(
                    {
                        "user_id": user_id,
                        "topic": "Why remote work makes cities worse",
                        "path": "draft",
                        "draft": "Initial draft text",
                        "conversation": [{"role": "user", "content": "hi"}],
                    }
                )
                .execute()
            )
            assert session.data, "session insert returned no rows"
            sid = session.data[0]["id"]
            initial_updated_at = session.data[0]["updated_at"]
            ok("insert with valid path = 'draft'")

            try:
                supabase.table("essay_sessions").insert(
                    {"user_id": user_id, "path": "bogus"}
                ).execute()
                fail("CHECK constraint on path was NOT enforced — 'bogus' accepted")
                failures.append("essay_sessions path CHECK")
            except Exception:
                ok("CHECK (path IN ('interactive','draft')) enforced")

            time.sleep(1.1)
            patched = (
                supabase.table("essay_sessions")
                .update({"so_what_answer": "Density compounds in person."})
                .eq("id", sid)
                .execute()
            )
            assert patched.data, "session update returned no rows"
            new_updated_at = patched.data[0]["updated_at"]
            assert new_updated_at != initial_updated_at, (
                "essay_sessions.updated_at trigger did not fire"
            )
            ok("update + updated_at trigger")
        except Exception as e:
            fail(f"essay_sessions: {e}")
            traceback.print_exc()
            failures.append("essay_sessions")

        # ------------------------------------------------------------------
        # ON DELETE CASCADE: deleting the user wipes their rows
        # ------------------------------------------------------------------
        step("auth.users ON DELETE CASCADE")
        try:
            supabase.auth.admin.delete_user(user_id)
            user_id = None  # don't try to delete it again in finally
            for table in ("voice_profiles", "essay_memory", "essay_sessions"):
                remaining = (
                    supabase.table(table)
                    .select("id")
                    .eq("user_id", created.user.id)
                    .execute()
                )
                assert not remaining.data, (
                    f"{table} still has rows for the deleted user "
                    f"({len(remaining.data)} found)"
                )
            ok("user delete cascaded across all three tables")
        except Exception as e:
            fail(f"cascade: {e}")
            traceback.print_exc()
            failures.append("cascade")

    finally:
        if user_id is not None:
            try:
                supabase.auth.admin.delete_user(user_id)
                print(f"\n  cleanup: deleted test user {user_id}")
            except Exception as e:
                print(f"\n  cleanup: failed to delete {user_id}: {e}")

    print()
    if failures:
        print(f"FAILED: {len(failures)} step(s) — {', '.join(failures)}")
        return 1
    print("OK — schema verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
