#!/bin/bash
set -e
umask 077

if [ -n "$GIT_USER_NAME" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "$GIT_USER_EMAIL" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

git config --global credential.helper 'store --file=/tmp/.git-credentials'
: > /tmp/.git-credentials

if [ -n "$GITHUB_TOKEN" ]; then
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" >> /tmp/.git-credentials
fi

if [ -n "$GITLAB_TOKEN" ]; then
  GITLAB_SCHEME=$(echo "${GITLAB_URL:-https://gitlab.com}" | sed 's|://.*||')
  GITLAB_NAME=$(echo "${GITLAB_URL:-https://gitlab.com}" | sed 's|.*://||' | sed 's|/.*||')
  echo "${GITLAB_SCHEME}://oauth2:${GITLAB_TOKEN}@${GITLAB_NAME}" >> /tmp/.git-credentials
  export GITLAB_HOST="${GITLAB_SCHEME}://${GITLAB_NAME}"
  printf "%s" "$GITLAB_TOKEN" | glab auth login --hostname "$GITLAB_NAME" --stdin
  glab config set -g host "$GITLAB_NAME"
  glab config set api_protocol "$GITLAB_SCHEME" --host "$GITLAB_NAME"
fi

chmod 600 /tmp/.git-credentials

if [ -n "$REPO_URL" ]; then
  if [ -z "$(ls -A /workspace 2>/dev/null)" ]; then
    echo "Cloning $REPO_URL into /workspace..."
    git clone "$REPO_URL" /workspace
  else
    echo "Directory /workspace already exists and is not empty -- skipping cloning $REPO_URL"
  fi
else
  echo "Error: REPO_URL not set"
  exit 1
fi

cd "/workspace"

echo "Starting container metadata server..."
tsx /opt/crc/packages/container-metadata-server/src/index.ts &

CLAUDE_SESSION="crc"
echo "Starting Claude Code session..."
if [ -n "$CRC_INITIAL_PROMPT" ]; then
  tmux new-session -d -s "$CLAUDE_SESSION" sh -c 'claude "$CRC_INITIAL_PROMPT"'
else
  tmux new-session -d -s "$CLAUDE_SESSION" claude
fi

echo "Starting web terminal..."
ttyd -p 8080 -i 0.0.0.0 -W \
  -I /opt/crc/ttyd-index.html \
  -t "fontFamily=\"${TTYD_FONT_FAMILY}\", monospace" \
  tmux attach -t "$CLAUDE_SESSION" &
TTYD_PID=$!
trap 'kill "$TTYD_PID" 2>/dev/null || true' TERM INT

wait "$TTYD_PID"
