# code-remote-control

A web app for managing Docker containers that each run Claude Code inside a mobile-friendly web terminal.

## Prerequisites

- Docker
- GitHub token for repository access
- A Claude OAuth token per configuration (run `claude setup-token`, or copy the
  `claudeAiOauth` block from a logged-in `~/.claude/.credentials.json`)

## Setup

Create your environment configuration file to specify the modes a container can be started in:

```json
{
    "root_domain": "example.com",
    "git": {
        "username": "joeoc2001-ai",
        "email": "joeoc2625.ai@gmail.com"
    },
    "gitlab_url": "https://gitlab.example.com",
    "configurations": [
        {
            "name": "claude-default",
            "oauth": {
                "accessToken": "sk-ant-oat01-...",
                "refreshToken": "sk-ant-ort01-...",
                "expiresAt": 1812345678000,
                "scopes": ["user:inference", "user:profile"],
                "subscriptionType": "max"
            },
            "docker": {
                "network_mode": "bridge",
                "networks": ["runner-network"],
                "shm_size": 2147483648,
                "nano_cpus": 4000000000,
                "memory": 8589934592,
                "binds": [
                    "/srv/cache/claude:/workspace/.cache"
                ],
                "device_requests": [
                    {
                        "driver": "nvidia",
                        "count": -1,
                        "capabilities": [["gpu"]]
                    }
                ]
            },
            "claude": {
                "model": "claude-opus-4-8"
            }
        }
    ]
}
```

Each configuration may carry its own Claude OAuth credentials in the `oauth` block;
when present, the server writes them to `~/.claude/.credentials.json` inside the
container at create time, so different configurations can use different tokens.
Provide a `refreshToken`/`expiresAt` for auto-refresh, or use a long-lived token
from `claude setup-token`.

The `oauth` block is optional. To run against a custom or proxy endpoint
(for example a LiteLLM proxy) instead of a Claude subscription, omit `oauth` and
set the Anthropic environment variables in the `env` block:

```json
"env": {
    "ANTHROPIC_BASE_URL": "http://litellm:4000",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "glm-5.2",
    "ANTHROPIC_SMALL_FAST_MODEL": "glm-5.2"
}
```

The optional `claude` block is merged into the container's `~/.claude/settings.json`
(the server force-injects the git-hygiene/task hooks and an autonomous permission
mode). Put any Claude Code settings here, e.g. `model`.

The `docker` block is optional per configuration. It maps directly to Docker host config fields in snake_case (for example `network_mode`, `cap_add`, `device_requests`, `runtime`, `restart_policy`, `ulimits`, and `devices`). Configure per-runner network attachment with `docker.networks`.

For GPU passthrough, set `device_requests` with NVIDIA capabilities as shown above.

Launch web server docker container:
```
services:
  code-remote-control:
    image: ghcr.io/joeoc2001/code-remote-control:latest
    container_name: code-remote-control
    ports:
      - "80:3000"
    environment:
      GITHUB_TOKEN: ghp_...
    volumes:
      - ./environments.json:/configs/environments.json:ro
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - runner-network
    restart: always
```

Note that the runners must be accessible from the CRC server, so must share at least one docker network.
