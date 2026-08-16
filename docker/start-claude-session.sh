#!/bin/bash
set -euo pipefail

SESSION_NAME="${1:?usage: start-claude-session.sh <tmux-session-name>}"
TRANSCRIPT_DIR="${CRC_TRANSCRIPT_DIR:-/root/.claude/projects/-workspace}"

export CRC_RESUME_PROMPT="The container running this session was restarted and the previous conversation has been resumed. Re-read the conversation above, inspect the current state of /workspace (current branch, uncommitted changes, work already pushed), then continue the task from where it left off."

if compgen -G "$TRANSCRIPT_DIR/*.jsonl" >/dev/null; then
  echo "Found a previous Claude Code transcript -- resuming that session..."
  exec tmux new-session -d -s "$SESSION_NAME" sh -c 'claude --continue "$CRC_RESUME_PROMPT"'
fi

if [ -n "${CRC_INITIAL_PROMPT:-}" ]; then
  echo "Starting a new Claude Code session with the initial prompt..."
  exec tmux new-session -d -s "$SESSION_NAME" sh -c 'claude "$CRC_INITIAL_PROMPT"'
fi

echo "Starting a new interactive Claude Code session..."
exec tmux new-session -d -s "$SESSION_NAME" claude
