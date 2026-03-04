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
  echo "Cloning $REPO_URL into /workspace..."
  git clone "$REPO_URL" /workspace
else
  echo "Error: REPO_URL not set"
  exit -1
fi

export REPO_DIR="$(ls /workspace)"
cd "/workspace/$REPO_DIR"

echo "Starting opencode..."
exec opencode web --port 8080 --hostname 0.0.0.0
