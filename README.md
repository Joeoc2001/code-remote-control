# code-remote-control

A web app for managing Docker containers that run opencode remote control instances.

## Prerequisites

- Docker
- GitHub token for repository access

## Setup

Create your environment configuration file to specify the modes a container can be started in:

```
{
  "configurations": [
    {
      "name": "gpt-5.3-codex",
      "opencode": {
        "$schema": "https://opencode.ai/config.json",
        "server": {
          "port": 4000,
          "hostname": "192.168.1.2"
        },
        "provider": {},
        "model": "gpt-5.3-codex",
        "small_model": "gpt-5.3-codex"
      }
    }
  ]
}
```

Launch web server docker container:
```
services:
  code-remote-control:
    image: ghcr.io/joeoc2001/code-remote-control:latest
    container_name: code-remote-control
    ports:
      - "80:3000"
    env:
      - GITHUB_TOKEN: ghp_...
      - GIT_USER_NAME: AI-name
      - GIT_USER_EMAIL: ai@email.com
    volumes:
      - ./environments.json:/configs/environments.json:ro
      - /var/run/docker.sock:/var/run/docker.sock
    restart: always
```