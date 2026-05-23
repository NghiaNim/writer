#!/bin/bash

# LLM Council - Start script (worktree-aware)
#
# When run from a git worktree, auto-assigns unique ports so multiple
# worktrees can run simultaneously without conflicts.
#
# Main checkout:  backend 8001, frontend 5173
# Worktrees:      backend 8001+offset, frontend 5173+offset
#                 (offset derived from worktree directory name)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Port assignment ──────────────────────────────────────────────────
# Detect if we're in a worktree by checking if .claude/worktrees/ is
# in our path.
WORKTREE_NAME=""
if [[ "$SCRIPT_DIR" == */.claude/worktrees/* ]]; then
    # Extract the worktree directory name (last path component under worktrees/)
    WORKTREE_NAME="$(basename "$SCRIPT_DIR")"
fi

if [[ -n "$WORKTREE_NAME" ]]; then
    # Deterministic offset from worktree name: hash → mod 100 → +1
    # Gives offsets 1–100, so backend ports 8002–8101, frontend 5174–5273
    HASH=$(printf '%s' "$WORKTREE_NAME" | cksum | cut -d' ' -f1)
    OFFSET=$(( (HASH % 100) + 1 ))
    BACKEND_PORT=$(( 8001 + OFFSET ))
    FRONTEND_PORT=$(( 5173 + OFFSET ))
    echo "🌿 Worktree: $WORKTREE_NAME"
    echo "   Port offset: +$OFFSET (backend $BACKEND_PORT, frontend $FRONTEND_PORT)"
else
    BACKEND_PORT=8001
    FRONTEND_PORT=5173
fi

# Allow explicit overrides
BACKEND_PORT="${PORT:-$BACKEND_PORT}"
FRONTEND_PORT="${FRONTEND_PORT:-$FRONTEND_PORT}"

# ── Check for port conflicts ────────────────────────────────────────
check_port() {
    if lsof -i ":$1" -sTCP:LISTEN &>/dev/null; then
        echo "ERROR: Port $1 is already in use."
        lsof -i ":$1" -sTCP:LISTEN 2>/dev/null | head -3
        return 1
    fi
    return 0
}

if ! check_port "$BACKEND_PORT" || ! check_port "$FRONTEND_PORT"; then
    echo ""
    echo "Kill the conflicting process or set PORT / FRONTEND_PORT env vars."
    exit 1
fi

# ── Shared state from main repo ──────────────────────────────────────
# Worktrees don't have .env or data/ — symlink from main repo so API
# keys, settings, and conversations are shared across all worktrees.
MAIN_REPO="$(git worktree list --porcelain 2>/dev/null | head -1 | sed 's/^worktree //')"
if [[ -n "$MAIN_REPO" ]]; then
    if [[ ! -f .env && -f "$MAIN_REPO/.env" ]]; then
        echo "Linking .env from main repo..."
        ln -s "$MAIN_REPO/.env" .env
    fi
    if [[ ! -e data && -d "$MAIN_REPO/data" ]]; then
        echo "Linking data/ from main repo..."
        ln -s "$MAIN_REPO/data" data
    fi
fi

# ── Dependencies ─────────────────────────────────────────────────────
# Worktrees share the git index but not node_modules or .venv — install
# if missing so start.sh is self-contained.
if [[ ! -d frontend/node_modules ]]; then
    echo "Installing frontend dependencies..."
    (cd frontend && npm install --silent)
fi

# ── Start backend ────────────────────────────────────────────────────
echo ""
echo "Starting backend on http://localhost:$BACKEND_PORT..."
PORT=$BACKEND_PORT uv run python -m backend.main &
BACKEND_PID=$!

sleep 2

# ── Start frontend ───────────────────────────────────────────────────
echo "Starting frontend on http://localhost:$FRONTEND_PORT..."
cd frontend

# Tell the frontend which backend to talk to
VITE_API_URL="http://localhost:$BACKEND_PORT" \
    npx vite --port "$FRONTEND_PORT" --host &
FRONTEND_PID=$!

cd ..

echo ""
echo "LLM Council is running!"
echo "  Backend:  http://localhost:$BACKEND_PORT"
echo "  Frontend: http://localhost:$FRONTEND_PORT"
if [[ -n "$WORKTREE_NAME" ]]; then
    echo "  Worktree: $WORKTREE_NAME"
fi
echo ""
echo "Press Ctrl+C to stop both servers"

# ── Cleanup ──────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "Stopping servers..."
    kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null
    echo "Done."
}

trap cleanup SIGINT SIGTERM
wait
