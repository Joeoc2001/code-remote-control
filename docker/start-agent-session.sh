#!/bin/bash
set -euo pipefail

SESSION_NAME="${1:?usage: start-agent-session.sh <tmux-session-name>}"
AGENT="${CRC_AGENT:?CRC_AGENT must name the agent harness to launch}"
WORKSPACE_DIR="${CRC_WORKSPACE_DIR:-/workspace}"
TRANSCRIPT_DIR="${CRC_TRANSCRIPT_DIR:-/root/.claude/projects/-workspace}"
ANTIGRAVITY_LAST_CONVERSATIONS_PATH="${CRC_ANTIGRAVITY_LAST_CONVERSATIONS_PATH:-/root/.gemini/antigravity-cli/cache/last_conversations.json}"
INSTANCE_STATUS_PATH="${CRC_INSTANCE_STATUS_PATH:-/run/crc-instance-status.json}"
SESSION_STARTED_AT_PATH="${CRC_RUN_DIR:-/run}/crc-session-started-at"
export CRC_HOOKS_DIR="${CRC_HOOKS_DIR:-/opt/crc/hooks}"

export CRC_RESUME_PROMPT="The container running this session was restarted and the previous conversation has been resumed. Re-read the conversation above, inspect the current state of /workspace (current branch, uncommitted changes, work already pushed), then continue the task from where it left off."

case "$AGENT" in
  claude)
    AGENT_LABEL="Claude Code"
    AGENT_COMMAND="claude"
    START_BARE='claude'
    START_WITH_INITIAL_PROMPT='claude "$CRC_INITIAL_PROMPT"'
    REOPEN_FINISHED='claude --continue'
    RESUME_WITH_PROMPT='claude --continue "$CRC_RESUME_PROMPT"'
    AFTER_CLEAN_EXIT=''
    ;;
  antigravity)
    AGENT_LABEL="Antigravity"
    AGENT_COMMAND="agy"
    START_BARE='agy --dangerously-skip-permissions'
    START_WITH_INITIAL_PROMPT='agy --dangerously-skip-permissions --prompt-interactive "$CRC_INITIAL_PROMPT"'
    REOPEN_FINISHED='agy --dangerously-skip-permissions --continue'
    RESUME_WITH_PROMPT='agy --dangerously-skip-permissions --continue --prompt-interactive "$CRC_RESUME_PROMPT"'
    AFTER_CLEAN_EXIT=' && node "$CRC_HOOKS_DIR/instance-status.js" finished'
    ;;
  *)
    echo "Error: unknown CRC_AGENT '$AGENT' (expected claude or antigravity)" >&2
    exit 1
    ;;
esac

HOLD_PANE_ON_FAILURE='status=$?; echo; echo "'"$AGENT_COMMAND"' exited with status $status -- the session could not be started. Press Ctrl-D to close this terminal."; exec cat'

launch() {
  date -u +%Y-%m-%dT%H:%M:%SZ > "$SESSION_STARTED_AT_PATH"
  exec tmux new-session -d -s "$SESSION_NAME" sh -c "$1$AFTER_CLEAN_EXIT || { $HOLD_PANE_ON_FAILURE; }"
}

previous_task_finished() {
  [ -f "$INSTANCE_STATUS_PATH" ] && grep -q '"state"[[:space:]]*:[[:space:]]*"finished"' "$INSTANCE_STATUS_PATH"
}

has_previous_session() {
  case "$AGENT" in
    claude) compgen -G "$TRANSCRIPT_DIR/*.jsonl" >/dev/null ;;
    antigravity) [ -f "$ANTIGRAVITY_LAST_CONVERSATIONS_PATH" ] && grep -qF "\"$WORKSPACE_DIR\":" "$ANTIGRAVITY_LAST_CONVERSATIONS_PATH" ;;
  esac
}

if has_previous_session; then
  if previous_task_finished; then
    echo "Found a previous $AGENT_LABEL transcript for a task that already finished -- reopening it without prompting the agent..."
    launch "$REOPEN_FINISHED"
  fi

  echo "Found a previous $AGENT_LABEL transcript -- resuming that session..."
  launch "$RESUME_WITH_PROMPT"
fi

if [ -n "${CRC_INITIAL_PROMPT:-}" ]; then
  echo "Starting a new $AGENT_LABEL session with the initial prompt..."
  launch "$START_WITH_INITIAL_PROMPT"
fi

echo "Starting a new interactive $AGENT_LABEL session..."
launch "$START_BARE"
