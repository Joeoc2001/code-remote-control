# code-remote-control

A web app for managing Docker containers that run opencode remote control instances.

## Prerequisites

- Docker
- opencode OAuth token 
- GitHub token for repository access

## Setup

1. Generate an opencode OAuth token on your host machine:
   ```bash
   opencode setup-token
   ```

2. Set required environment variables:
   ```bash
   export GITHUB_TOKEN=ghp_your-github-token-here
   ```

3. Create your environment configuration file at `configs/environments.json`:

Example `environments.json`:

```
{
  "configurations": [
    {
      "name": "default",
      "description": "Standard opencode environment",
      "env": {
        "OPENCODE_ARGS": "",
        "GIT_USER_NAME": "Your Name",
        "GIT_USER_EMAIL": "you@example.com"
      }
    },
    {
      "name": "with-custom-model",
      "description": "opencode with custom model override",
      "env": {
        "OPENCODE_ARGS": "--model gpt-5.3-codex",
        "GIT_USER_NAME": "Your Name",
        "GIT_USER_EMAIL": "you@example.com"
      }
    }
  ]
}
```