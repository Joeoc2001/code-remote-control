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

The instance-status hooks record what Claude is doing, as one of four states:
`working`, `waiting`, `awaiting-background`, or `finished`. Submitting a prompt
marks the instance as working; an AskUserQuestion or permission prompt marks it
`waiting` until the answer resumes the turn; the Stop hook marks it finished once
it lets Claude stop (it stays working while the git-hygiene hook blocks the
stop); and a SessionEnd hook marks it finished when the session goes away without
a Stop event.

Claude Code fires Stop at the end of every turn, including the turn in which the
agent launches background work (background subagents, `run_in_background` Bash)
and ends its response to wait for the results. So before allowing a stop, the
git-hygiene hook scans the session transcript it is handed for background tasks
that have been launched but have not notified yet, and records
`awaiting-background` instead of `finished` when any are still outstanding — the
stop itself is still allowed, so the notification wakes the agent as usual, and
the next Stop after the work lands records `finished`. The status file lists each
outstanding task as `{ id, kind, label }`, where `kind` is `shell`, `agent` or
`remote` and `label` is the description the agent gave when launching it.

Background shells are different from agents: a shell that never exits (a "wait
until X" loop, a watcher, a dev server) never notifies, so it would hold the
container on `awaiting-background` forever. So the first time a turn ends with
background shells still running, the hook blocks the stop and lists them,
asking the agent to `TaskStop` any it is no longer waiting on. If the agent ends
its turn again with the same shells running, the hook accepts that it really is
waiting on them and records `awaiting-background`.

The uncommitted/unpushed check runs before the background check, so a dirty tree
is still reported while background work is pending. The CI watch only runs once
no background work is outstanding.

The state lives in `/run/crc-instance-status.json` inside the container, is served
by the container metadata server on `/api/instance-status`, proxied by the app on
`/api/containers/:id/instance-status`, and shown as a
Working/Waiting/Waiting-on-shells/Waiting-on-agents/Finished badge in the UI
("Waiting on background tasks" when both kinds are outstanding).

Alongside `updatedAt` (the time the state last changed, which the badge and card
ordering use), the status file carries a `lastActivityAt` heartbeat. Every hook
invocation (each prompt and each completed tool call) refreshes it, but while
the state is unchanged the hook rewrites the file at most once a minute and
keeps the original `updatedAt`. Files written by older hooks without
`lastActivityAt` fall back to `updatedAt`.

Known limitation: interrupting a turn from the terminal (Esc) fires no hook, so the
badge keeps reading "Working" until the next stop or session end. The badge tooltip
shows when the state last changed, which makes a stale "Working" recognisable.

When a task's agent stalls, the server pokes it by typing a one-line prompt into
the container's tmux session (named by `CRC_TMUX_SESSION`, which the server passes
to the container) with `docker exec tmux send-keys`, followed by Enter.

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
      GITHUB_MERGE_TOKEN: github_pat_...
      CRC_ACCESS_TOKEN: choose-a-long-random-secret
    volumes:
      - ./environments.json:/configs/environments.json:ro
      - ./data:/data
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - runner-network
    restart: always
    stop_grace_period: 30s
```

The configuration is read from `/configs/environments.json`; override the path with `CRC_CONFIG_PATH`.

Note that the runners must be accessible from the CRC server, so must share at least one docker network.

The `/data` volume holds Task state (`tasks.json` plus captured per-attempt log
tails) and the quick-prompts (`quick-prompts.json`, including each prompt's
perpetual flag, stored configuration and the PRs/MRs it has opened) so both
survive server restarts. Override the location with `CRC_STATE_DIR`. Without
the volume, tasks and quick-prompts are lost whenever the container is
recreated.

A quick-prompt marked perpetual on the Quick-prompts page relaunches itself as
a brand-new task once its last task has merged and its issue is closed (after
every stage), provided no PR/MR opened from the prompt is still open. A failed
or paused last task blocks the relaunch until it is resumed or deleted.

Agent containers outlive the server too. Each one is labelled with the task and
step it was spawned for, and every scheduler tick reconciles the labelled
containers against `tasks.json`: a container whose spawn the server never got to
record (it was restarted mid-spawn) is adopted as the task's active attempt, and
a container whose task was deleted, already finished that attempt, never
started, or moved on is removed. On SIGTERM the server lets the in-flight
scheduler tick finish before exiting so the state on disk matches what it did;
a tick can spend a while pulling an image, so give the server up to 25 seconds
to stop (hence `stop_grace_period: 30s` above, which is longer than Docker's
10 second default).

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
2. CI failing → a **fix CI** agent; CI in flight → wait, unless the PR/MR is
   already known to need rebasing, in which case the rebase happens eagerly
   instead of waiting for a CI result the rebase would invalidate anyway.
3. Behind the target branch without conflicts → a fast-forward rebase via the
   forge API on GitLab, or a **rebase** agent on GitHub (where the API
   equivalent would create a merge commit). A rebase agent also addresses any
   nits or minor non-blocking suggestions left by earlier reviews, in separate
   commits on top of the rebase.
4. Merge conflicts → a **rebase** agent, which likewise folds in any review
   nits.
5. Head commit changed since the last review → a **review** agent, then an
   **address comments** agent while unresolved threads remain. A moved head is
   only re-reviewed when the PR/MR's diff actually changed with it, so a clean
   rebase (server-side or agent-driven) carries the reviewed state forward
   instead of burning another review. A rebase agent that also fixed nits does
   change the diff, so it legitimately triggers a fresh review.
6. Green, reviewed, and comment-free → the task waits for a human approval
   (approvals from the bot's own forge account are ignored), then merges via
   the forge API.

### Approvals stored in CRC

Once CRC sees a human approval it stores it on the task, so it survives forges
that reset approvals on push (e.g. GitLab's "Reset approvals on push" after a
rebase). Every agent that pushes code (implement, rebase, fix CI, address
comments) must write `true` or `false` to `/run/crc-is-material` before it
finishes; an agent that leaves it unwritten (or writes anything else) is held
like any other missing deliverable. The stored approval then follows the
PR/MR's head:

- `true` (a material change) cancels it, and the task waits for a fresh human
  approval.
- `false`, or a fast-forward rebase via the forge API, lets it carry over to
  the next head.
- Any other head change keeps it only if the diff is identical to the approved
  one; an unexplained push with a different diff cancels it. A human withdrawing
  their approval on the forge, without the head moving, cancels it too.

A stored approval only replaces the final human-approval gate: CI, rebasing,
review, and unresolved threads still gate the merge. When it carries over to a
head the forge no longer shows as approved, the server re-approves the PR/MR
at that head with the merge token before merging, so the merge token's account
must be allowed to approve it (and must not be the author if the project
forbids self-approval). The task view shows the stored approval with a
**Revoke approval** button, and each attempt's material / not-material report.

Because the merge token's account counts as human, CRC's own re-approval would
otherwise look like a fresh human approval on the next tick. So whenever CRC
cancels a stored approval (a material change, an unexplained push, or **Revoke
approval**) it also withdraws every approval the merge token's account holds on
the PR/MR: GitLab's `unapprove`, or dismissing those reviews on GitHub (which
needs the merge token's account to be allowed to dismiss reviews). If your own
PAT is the merge token, this withdraws your own approval too. The stored
approval is cleared once the PR/MR merges.

### Merge token

Agents get `GITHUB_TOKEN` / `GITLAB_TOKEN`, which should not be able to merge
into the default branch. The server merges approved PRs/MRs with a separate,
privileged token instead:

- `GITHUB_MERGE_TOKEN` — a fine-grained PAT with `Contents: write` and
  `Pull requests: write`. If the target branch is protected, the token's account
  must be allowed to bypass the protection or be on the merge allowlist.
- `GITLAB_MERGE_TOKEN` — a token with the `api` scope whose account has
  Maintainer access or is "allowed to merge" on the protected branch.

The merge token is used only for the approve, unapprove and merge calls and is never
passed to agent containers; the server refuses to create a container whose `env` would carry
it. Every other forge call, including the fast-forward rebase, uses the agent
token. Approvals are attributed against the agent token's account, so approvals
made by the merge token's account (e.g. your own PAT) still count as human.

A merge token equal to its agent token is rejected at startup. If a merge token
is unset the server warns and merges with the agent token, which fails under
branch protection; merge errors name the token that was used.

Each step runs under a per-step configuration chosen at task creation. An agent
counts as done only once its container reports `finished` on two consecutive
ticks with an unchanged HEAD; anything else — including `awaiting-background` —
leaves it running. When an agent finishes with its deliverable in place, its
container's log tail and PR/MR link are captured, the container is removed, and
the task settles for one tick before deciding again.
The task detail page shows the full attempt timeline with the captured logs.

Safety rails: fix-CI and rebase each spawn at most 3 times, an implement agent
that ends without opening a PR/MR is never retried automatically, and a task
spawns at most 12 agents in total before failing; a stalled attempt is poked
every 30 minutes, where stalled means it is not `waiting` or `finished` and none
of its start, resume, last poke or `lastActivityAt` heartbeat is less than 30
minutes old (this covers `awaiting-background` agents, silently hung `working`
agents, and unreachable metadata servers); an attempt is held once 24 hours have
passed since it started or was resumed, however often it has been poked; an
agent reporting `waiting` is never poked or held, so an agent parked on a
question survives until someone answers; repeated errors (forge errors, or five
back-to-back poke failures) fail the task; paused tasks are never evaluated; and
each work item can have only one live task.

When an attempt is still unfinished after 24 hours, finishes without its
deliverable (an implement agent that never opened a PR/MR, or an issue-creating
agent that never reported an issue URL), or its task fails on repeated errors,
the task fails but the agent container is **held** rather than removed: it stays
the task's active container, its log tail is captured, and the attempt shows as
*Held* with a Terminal link so you can inspect the agent or prompt it to
continue by hand. A held task offers two retries: **Retry with same agent** puts
the container back under the scheduler's watch with a fresh 24-hour window and a
30-minute grace period before its next poke (if the agent has since opened its
PR/MR the task advances), and **Discard & retry** removes the container and
spawns a fresh agent. Held containers keep running and consuming resources until
the task is retried with discard, deleted, or the container is removed by hand
from the Home grid.

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
