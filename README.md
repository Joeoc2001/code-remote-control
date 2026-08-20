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
prompt marks the instance as working, the Stop hook marks it as finished once it
lets Claude stop (it stays working while the git-hygiene hook blocks the stop), and
a SessionEnd hook marks it finished when the session goes away without a Stop event.
The state lives in `/run/crc-instance-status.json` inside the container, is served
by the container metadata server on `/api/instance-status`, proxied by the app on
`/api/containers/:id/instance-status`, and shown as a Working/Finished badge in the
UI.

Known limitation: interrupting a turn from the terminal (Esc) fires no hook, so the
badge keeps reading "Working" until the next stop or session end. The badge tooltip
shows when the state last changed, which makes a stale "Working" recognisable.

The `docker` block is optional per configuration. It maps directly to Docker host config fields in snake_case (for example `network_mode`, `cap_add`, `device_requests`, `runtime`, `restart_policy`, `ulimits`, and `devices`). Configure per-runner network attachment with `docker.networks`.

`docker.auto_remove` may only be `false`: a container that deletes itself on exit
takes the workspace and the Claude Code transcripts with it, so the session could
never be resumed. Configs that enable it are rejected at load time.

For GPU passthrough, set `device_requests` with NVIDIA capabilities as shown above.

The optional top-level `merge_method` (`"merge"`, `"squash"`, or `"rebase"`)
controls how Tasks merge PRs. On GitLab only `"squash"` changes behaviour (the
project's own merge method setting governs the rest).

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
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - runner-network
    restart: always
```

Note that the runners must be accessible from the CRC server, so must share at least one docker network.

The `/data` volume holds Task state (`tasks.json` plus captured per-attempt log
tails) so tasks survive server restarts. Override the location with
`CRC_STATE_DIR`. Without the volume, tasks are lost whenever the container is
recreated.

## Restarts

When a container restarts — a host reboot, a `docker restart`, or a restart policy
firing after a crash — the writable layer survives, so `/workspace` and
`/root/.claude` still hold the previous run's work and conversation. The
entrypoint hands the session launch to `docker/start-claude-session.sh`, which
checks for a Claude Code transcript in `/root/.claude/projects/-workspace` and,
if one exists, starts the session with `claude --continue` plus a prompt telling
the agent that the container restarted and to carry on from where it left off.
The original `CRC_INITIAL_PROMPT` is only replayed on the container's first
start, so a restart never re-runs a task from scratch against a half-finished
workspace.

If the instance status recorded in `/run/crc-instance-status.json` says the
previous task had already finished, the session is reopened with a bare
`claude --continue` instead. The conversation is still there to read in the web
terminal, but the agent is not prompted, so a host reboot does not wake every
completed container back up.

The resume prompt is exported as `CRC_RESUME_PROMPT` so the task-description hook
can ignore it and keep showing the real task in the UI.

Docker only restarts containers automatically after a daemon restart when their
restart policy is `always` or `unless-stopped`; set
`docker.restart_policy.name` to `unless-stopped` for reliable comeback after a
reboot. Recreating a container (delete and re-create, or an image upgrade) still
starts from scratch — nothing survives `docker rm`.

## Tasks

The **Tasks** tab shepherds a work item from issue to merged PR/MR without a
human in the loop. A task repeatedly evaluates its PR/MR's forge state every 30
seconds and spawns exactly the agent the current state calls for:

1. No PR/MR yet → an **implement** agent (its deliverable is an open PR/MR; if
   it finishes without opening one, the task fails rather than retrying).
2. CI failing → a **fix CI** agent; CI in flight → wait.
3. Behind the target branch without conflicts → a fast-forward rebase via the
   forge API on GitLab, or a **rebase** agent on GitHub (where the API
   equivalent would create a merge commit).
4. Merge conflicts → a **rebase** agent.
5. Head commit changed since the last review → a **review** agent, then an
   **address comments** agent while unresolved threads remain.
6. Green, reviewed, and comment-free → the task waits for a human approval
   (approvals from the bot's own forge account are ignored), then merges via
   the forge API.

Each step runs under a per-step configuration chosen at task creation. When an
agent finishes, its container's log tail and PR/MR link are captured, the
container is removed, and the task settles for one tick before deciding again.
The task detail page shows the full attempt timeline with the captured logs.

Safety rails: implement/fix-CI/rebase each spawn at most 3 times and a task
spawns at most 12 agents in total before failing; a wedged attempt is killed
after 2 hours (an interrupted agent can otherwise report "working" forever —
see the known limitation above); repeated forge errors fail the task; paused
tasks are never evaluated; and each work item can have only one live task.

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

## Tests

```
npm install
npm test
```

The suite covers the container session/restart logic (including a pass that drives
real `tmux`, so `tmux` must be installed), the Claude hooks, and the configuration
schema.
