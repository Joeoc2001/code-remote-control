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

The `oauth`, `claude`, `env`, and `docker` blocks can also appear at the top
level of the file, where they act as defaults for every configuration. A
configuration's own block is merged over the top-level one key by key — e.g. a
top-level `env` of `{"FOO": "1", "BAR": "2"}` combined with a configuration
`env` of `{"BAR": "3", "BAZ": "4"}` yields `{"FOO": "1", "BAR": "3", "BAZ":
"4"}`. Each configuration must end up with an `oauth` block, either its own or
the top-level default.

Each configuration carries its own Claude OAuth credentials in the `oauth` block;
the server writes them to `~/.claude/.credentials.json` inside the container at
create time, so different configurations can use different tokens. Provide a
`refreshToken`/`expiresAt` for auto-refresh, or use a long-lived token from
`claude setup-token`.

The optional `claude` block is merged into the container's `~/.claude/settings.json`
(the server force-injects the git-hygiene/task/instance-status hooks and an
autonomous permission mode). Put any Claude Code settings here, e.g. `model`.

The instance-status hooks record whether Claude is still working: submitting a
prompt marks the instance as working, and the Stop hook marks it as finished once
it lets Claude stop (it stays working while the git-hygiene hook blocks the stop).
The state lives in `/run/crc-instance-status.json` inside the container, is served
by the container metadata server on `/api/instance-status`, proxied by the app on
`/api/containers/:id/instance-status`, and shown as a Working/Finished badge in the
UI.

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
      CRC_ACCESS_TOKEN: choose-a-long-random-secret
    volumes:
      - ./environments.json:/configs/environments.json:ro
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - runner-network
    restart: always
```

Note that the runners must be accessible from the CRC server, so must share at least one docker network.

## Authentication

Set `CRC_ACCESS_TOKEN` to protect the dashboard, the API, and the per-container
terminals with a shared secret. When it is set, the server requires the token on
every request (including the proxied `*.root_domain` terminals and their
WebSocket connections). Authenticate a browser by visiting
`https://<root_domain>/?access_token=<token>` once — the server stores an
`HttpOnly` cookie scoped to `.root_domain` (covering every container subdomain)
and redirects to a clean URL. Programmatic clients can instead send
`Authorization: Bearer <token>`.

If `CRC_ACCESS_TOKEN` is left unset the server starts with authentication
disabled and logs a warning; only do this on a trusted, isolated network.
