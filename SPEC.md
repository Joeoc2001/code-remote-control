# Code Remote Control — Project Specification

## Overview

Code Remote Control (CRC) is a self-hosted web application for managing Docker containers that run Claude Code Remote instances on a homeserver. It provides a UI to spawn, monitor, and tear down isolated development environments, each pre-loaded with a GitHub repository and a running Claude Code Remote server. The application is accessed over a VPN and does not require authentication.

---

## Architecture

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Tailwind CSS |
| Backend | Node.js, Express, TypeScript |
| Container management | Dockerode (Docker Engine API via mounted socket) |
| Build tooling | Vite (frontend), tsx / tsc (backend) |
| CI/CD | GitHub Actions |
| Package manager | npm workspaces (monorepo) |

### Monorepo Structure

```
code-remote-control/
├── packages/
│   ├── client/          # React + Tailwind frontend (Vite)
│   └── server/          # Express backend (TypeScript)
├── docker/
│   ├── Dockerfile.app   # Builds the CRC application image
│   └── Dockerfile.env   # Claude Code environment image
├── configs/
│   └── environments.json  # Named container configurations
├── .github/
│   └── workflows/
│       ├── ci.yml       # PR type-check
│       └── build.yml    # Build & push app image on merge to main
├── package.json         # Workspace root
├── tsconfig.base.json   # Shared TypeScript config
└── SPEC.md
```

### Deployment Model

- **Single container**: The Express server serves the built React static files and exposes the API on a single port (default `3000`).
- **Docker socket mount**: The app container mounts `/var/run/docker.sock` to manage sibling containers on the host.
- **No database**: State is discovered at runtime by scanning Docker for containers with the `crc-` name prefix. No persistent storage is required.

---

## Container Configuration

### Named Configurations (`configs/environments.json`)

A JSON file defining a list of named container configurations. Each configuration specifies only environment variables — no resource limits.

```jsonc
{
  "configurations": [
    {
      "name": "default",
      "description": "Standard Claude Code environment",
      "env": {
        "CLAUDE_CODE_ARGS": "",
        "GIT_USER_NAME": "Your Name",
        "GIT_USER_EMAIL": "you@example.com"
      }
    },
    {
      "name": "with-custom-model",
      "description": "Claude Code with custom model override",
      "env": {
        "CLAUDE_CODE_ARGS": "--model claude-sonnet-4-6",
        "GIT_USER_NAME": "Your Name",
        "GIT_USER_EMAIL": "you@example.com"
      }
    }
  ]
}
```

### Container Naming

All managed containers use the prefix `crc-` followed by a descriptive slug:

```
crc-<config-name>-<repo-short-name>-<8-char-random-id>
```

Example: `crc-default-my-project-a1b2c3d4`

---

## Environment Dockerfile (`docker/Dockerfile.env`)

A single Dockerfile that produces the image used for all spawned environments. It includes:

### Pre-installed Toolchains

| Language | Tools |
|---|---|
| Node.js | Node.js LTS, npm, yarn |
| Python | Python 3, pip, venv |
| Rust | rustup, cargo, rustc (stable) |
| Go | Go (latest stable) |
| Java | OpenJDK (LTS) |
| C/C++ | g++, cmake, make |

### Pre-installed Utilities

- Git
- Claude Code (`@anthropic-ai/claude-code` via npm, installed globally)
- curl, wget, jq, ripgrep
- Docker CLI (for nested use cases if needed)

### Entrypoint Behaviour

The container entrypoint script performs the following steps in order:

1. Configure git with user name/email from environment variables.
2. Clone the specified GitHub repository (`REPO_URL` env var) into `/workspace`.
3. `cd /workspace`.
4. Start the Claude Code Remote server (`claude --remote`), passing through any additional args from `CLAUDE_CODE_ARGS`.
5. Capture stdout and stream it to Docker logs so the app can read the Remote URL.

---

## Backend API (`packages/server`)

### Endpoints

#### `GET /api/containers`

List all managed containers (those with the `crc-` prefix).

**Response:**

```json
[
  {
    "id": "abc123...",
    "name": "crc-default-my-project-a1b2c3d4",
    "configName": "default",
    "repoName": "owner/my-project",
    "status": "running",
    "health": {
      "container": "running",
      "claudeCode": "healthy"
    },
    "remoteUrl": "https://claude.ai/code/session_...",
    "createdAt": "2026-02-25T10:30:00Z"
  }
]
```

#### `POST /api/containers`

Spawn a new container.

**Request body:**

```json
{
  "configName": "default",
  "repoFullName": "owner/repo-name"
}
```

**Response:** Returns the created container object. The `remoteUrl` field is initially `null` and will be populated once the Claude Code Remote server outputs the URL.

#### `DELETE /api/containers/:id`

Kill and remove a managed container. Removes the container and its associated volumes.

**Response:** `204 No Content`

#### `GET /api/containers/:id/logs`

Stream container logs via Server-Sent Events (SSE). Used to capture the Claude Code Remote URL in real time.

#### `GET /api/configs`

Return the list of named configurations from `environments.json`.

**Response:**

```json
{
  "configurations": [
    { "name": "default", "description": "Standard Claude Code environment", "env": { ... } }
  ]
}
```

#### `GET /api/github/repos`

Fetch repositories from the authenticated GitHub account using a GitHub Personal Access Token (stored as the `GITHUB_TOKEN` environment variable on the CRC server).

**Response:**

```json
{
  "repos": [
    { "fullName": "owner/repo-name", "description": "A repo", "private": false, "defaultBranch": "main" }
  ]
}
```

### Real-time Updates

The backend uses **Server-Sent Events (SSE)** on `GET /api/events` to push real-time updates to the frontend:

- Container status changes (created, running, stopped, removed)
- Health check results
- Remote URL captured from stdout

### Health Checking

A background process runs periodically (every 30 seconds) and performs:

1. **Docker status check**: Query the Docker API for container state (`running`, `exited`, etc.).
2. **Claude Code process check**: Execute `docker exec <container> pgrep -f "claude"` to verify the Claude Code process is alive inside the container.

Results are cached in memory and broadcast via SSE.

---

## Frontend (`packages/client`)

### Pages / Views

The app is a single-page application with one main view.

#### Container Dashboard

The primary and only view, consisting of:

1. **Header bar**: App title ("Code Remote Control") and a "New Container" button.

2. **Container list**: A card grid showing all managed containers. Each card displays:
   - Container name (short form, without `crc-` prefix)
   - Configuration name used
   - Repository name
   - Status badge (running / stopped / error)
   - Health indicator (green/yellow/red dot)
     - Green: container running + Claude Code process healthy
     - Yellow: container running but Claude Code process not detected
     - Red: container stopped or errored
   - **Remote URL**: Clickable link + copy-to-clipboard button. Shown once the URL is captured. Before capture, show a spinner with "Waiting for Remote URL...".
   - **Kill** button: Prompts for confirmation, then kills and removes the container.

3. **"New Container" dialog** (modal): Opened by the header button. Contains:
   - A dropdown to select a named configuration (from `/api/configs`).
   - A searchable dropdown to select a GitHub repository (from `/api/github/repos`).
   - A "Spawn" button.
   - After spawning, the modal closes and the new container card appears in the list with a "starting" status. The card live-updates via SSE as the container boots and the Remote URL is captured.

### Styling

- Tailwind CSS with a dark theme by default (appropriate for a developer tool).
- Responsive but primarily designed for desktop use.

---

## Application Dockerfile (`docker/Dockerfile.app`)

Multi-stage build:

1. **Stage 1 — Build**: Use a Node.js base image. Install dependencies, build the frontend (`vite build`), compile the backend TypeScript.
2. **Stage 2 — Runtime**: Use a slim Node.js base image. Copy built assets and compiled server code. Expose port `3000`. Set entrypoint to start the Express server.

The resulting image is what gets deployed on the homeserver.

---

## GitHub Actions

### `ci.yml` — PR Type Check

**Trigger:** Pull request to `main`.

**Steps:**

1. Checkout code.
2. Install Node.js.
3. `npm ci` (install dependencies).
4. `npm run typecheck` (runs `tsc --noEmit` across all workspace packages).

### `build.yml` — Build & Push App Image

**Trigger:** Push to `main`.

**Steps:**

1. Checkout code.
2. Log in to GitHub Container Registry (`ghcr.io`).
3. Build `docker/Dockerfile.app`.
4. Tag as `ghcr.io/<owner>/code-remote-control:latest` and `ghcr.io/<owner>/code-remote-control:<sha>`.
5. Push to GHCR.

---

## Environment Variables

The CRC application container expects these environment variables at runtime:

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token for listing repositories. Must have `repo` scope. |
| `PORT` | No | Port to listen on. Default: `3000`. |

The spawned environment containers receive:

| Variable | Source | Description |
|---|---|---|
| `REPO_URL` | Set by CRC at spawn time | Full HTTPS clone URL of the selected repository. |
| `GITHUB_TOKEN` | Forwarded from CRC | PAT for cloning private repositories. |
| `GIT_USER_NAME` | From config `env` | Git author name. |
| `GIT_USER_EMAIL` | From config `env` | Git author email. |
| `CLAUDE_CODE_ARGS` | From config `env` | Additional CLI arguments for `claude --remote`. |
| `ANTHROPIC_API_KEY` | Forwarded from CRC | API key for Claude Code. |

---

## Key Design Decisions

1. **No database**: Managed containers are discovered by the `crc-` name prefix. This keeps the app stateless and simple. Metadata (config name, repo) is stored as Docker container labels.
2. **Docker socket mount**: Standard pattern for container management apps. The app runs as a sibling container and communicates with the Docker daemon via the Unix socket.
3. **SSE over WebSockets**: Server-Sent Events are simpler to implement for the one-way server-to-client push needed for status updates and log streaming.
4. **Single container deployment**: Express serves the React static build. One port, one container, minimal operational complexity for a homeserver.
5. **Dockerode**: Well-maintained Node.js Docker client library that maps cleanly to the Docker Engine API.
6. **Container labels for metadata**: Config name, repo URL, and other metadata are stored as Docker labels on each managed container, allowing full state reconstruction from Docker alone.

---

## Out of Scope (v1)

- Authentication / authorization (accessed via VPN)
- Container resource limits (CPU, memory)
- Container pause / restart (spawn and kill only)
- Persistent storage or database
- Multi-host / Docker Swarm / Kubernetes support
- Container terminal / shell access from the UI
- Webhook or push notifications for Remote URLs
