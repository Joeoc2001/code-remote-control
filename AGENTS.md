This is a repo for a web app which lets me manage containers for running Claude Code remote instances on my home PC. It is built with Node/Express/React/Tailwind and integrates with both Docker and GitHub.

## Functionality

This app functions as a wrapper around Docker to spawn containers which each run Claude Code inside a mobile-friendly web terminal (ttyd attached to a tmux session).

## Repo setup

The repo is composed of 2 docker container definitions:
- `env` describes the container which is spun up for each Claude Code instance, providing devtools and a sandbox;
- `app` gives the webserver.

These can both be found in `./docker`.

The remainder of the TS code is in `./packages`:

- `server` — Express backend; manages Docker containers, proxies traffic to them, and integrates with GitHub/GitLab.
- `client` — React/Tailwind frontend; the UI for creating and monitoring containers.
- `shared` — Types shared between `server` and `client` (config schemas, container shapes, SSE events).
- `container-metadata-server` — Lightweight HTTP server that runs *inside* each `env` container; exposes `/api/code-status` with git branch, commit, PR/MR, and pipeline info.
- `container-metadata-types` — TypeScript types for the `container-metadata-server` API, consumed by both the metadata server and the main server.

# Repo rules:
- Do not add superfluous comments. Your code should be self-documenting — ideally your code should contain no comments at all.
- Always prefer to fail fast and fail loudly over recovering from errors.
- The code is not licensed, and especially not under MIT. 
- We are the only user of the API — do not be afraid to change endpoint names and schemas.

## Debugging: viewing live logs from inside a dev/agent environment

Each agent runs inside a `crc-*` container that the CRC server spawned. From that
container you can watch live container logs by talking to the CRC server's own
HTTP API over the shared Docker network — no Docker socket is mounted in agent
containers, so this API is the way in.

Steps:

1. The server container is named `code-remote-control` and is reachable by that
   hostname on its internal port `3000` (the compose file maps `80:3000` on the
   host, but from inside the network you use `3000`). Every runner shares at least
   one Docker network with it, so `http://code-remote-control:3000` resolves.
2. Authentication: if the deployment sets `CRC_ACCESS_TOKEN`, send it as
   `Authorization: Bearer $CRC_ACCESS_TOKEN` or a `?access_token=...` query param.
   Self-hosted/dev deployments often leave it unset, in which case the API is open.
3. Find the container id you want. Your own short id is `hostname`; the full list
   (with names, repos, health) is `GET /api/containers`.
4. Stream live logs (this is `docker logs -f --tail 100`, stdout+stderr demuxed):

   ```
   curl -N http://code-remote-control:3000/api/containers/<id>/logs
   ```

   The response is Server-Sent Events; each line arrives as
   `data: {"log":"..."}`, and an `event: end` is sent when the stream closes.

Other useful read-only endpoints on the same server:

- `GET /api/containers` — all managed containers and their health.
- `GET /api/containers/:id/instance-status` — the agent's working/waiting state.
- `GET /api/containers/:id/code-status` — git branch, commit, PR/MR, pipeline.
- `GET /api/events` — SSE bus of server-side container events.

Note: the log endpoint only serves server-managed `crc-*` containers
(`assertManagedContainer` rejects anything else), so the CRC server's *own*
process logs are not exposed this way — only agent-container logs are.
