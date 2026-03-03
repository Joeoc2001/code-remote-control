#!/bin/bash
set -e

if [ -n "$GIT_USER_NAME" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "$GIT_USER_EMAIL" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper 'store --file=/tmp/.git-credentials'
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > /tmp/.git-credentials
  chmod 600 /tmp/.git-credentials
fi

if [ -n "$REPO_URL" ]; then
  echo "Cloning $REPO_URL into /workspace/remote-control..."
  git clone "$REPO_URL" /workspace/remote-control
else
  echo "Warning: REPO_URL not set, starting in empty /workspace directory"
  mkdir -p /workspace/remote-control
fi

cd /workspace

echo "Starting opencode Remote..."
eval "extra_args=(${OPENCODE_ARGS:-})"
exec opencode remote-control "${extra_args[@]}"
