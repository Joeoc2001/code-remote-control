#!/bin/bash
set -e

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
  echo "Cloning $REPO_URL into /workspace..."
  git clone "$REPO_URL" /workspace
else
  echo "Error: REPO_URL not set"
  exit -1
fi

cd "/workspace"

echo "Starting opencode..."
exec opencode web --port 8080 --hostname 0.0.0.0
