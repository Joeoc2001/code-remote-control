#!/bin/bash
set -euo pipefail

SESSION_NAME="${1:?usage: start-claude-session.sh <tmux-session-name>}"
TRANSCRIPT_DIR="${CRC_TRANSCRIPT_DIR:-/root/.claude/projects/-workspace}"
INSTANCE_STATUS_PATH="${CRC_INSTANCE_STATUS_PATH:-/run/crc-instance-status.json}"

export CRC_RESUME_PROMPT="The container running this session was restarted and the previous conversation has been resumed. Re-read the conversation above, inspect the current state of /workspace (current branch, uncommitted changes, work already pushed), then continue the task from where it left off."

HOLD_PANE_ON_FAILURE='status=$?; echo; echo "claude exited with status $status -- the session could not be started. Press Ctrl-D to close this terminal."; exec cat'

launch() {
  exec tmux new-session -d -s "$SESSION_NAME" sh -c "$1 || { $HOLD_PANE_ON_FAILURE; }"
}

previous_task_finished() {
  [ -f "$INSTANCE_STATUS_PATH" ] && grep -q '"finished"[[:space:]]*:[[:space:]]*true' "$INSTANCE_STATUS_PATH"
}

if compgen -G "$TRANSCRIPT_DIR/*.jsonl" >/dev/null; then
  if previous_task_finished; then
    echo "Found a previous Claude Code transcript for a task that already finished -- reopening it without prompting the agent..."
    launch 'claude --continue'
  fi

  echo "Found a previous Claude Code transcript -- resuming that session..."
  launch 'claude --continue "$CRC_RESUME_PROMPT"'
fi

if [ -n "${CRC_INITIAL_PROMPT:-}" ]; then
  echo "Starting a new Claude Code session with the initial prompt..."
  launch 'claude "$CRC_INITIAL_PROMPT"'
fi

echo "Starting a new interactive Claude Code session..."
launch claude
