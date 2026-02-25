#!/bin/bash
set -e

# 1. Configure git
if [ -n "$GIT_USER_NAME" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "$GIT_USER_EMAIL" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

# Configure git credentials for private repos
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# 2. Clone repository
if [ -n "$REPO_URL" ]; then
  echo "Cloning $REPO_URL into /workspace..."
  git clone "$REPO_URL" /workspace
fi

# 3. cd /workspace
cd /workspace

# 4. Start Claude Code Remote
echo "Starting Claude Code Remote..."
exec claude --remote $CLAUDE_CODE_ARGS
