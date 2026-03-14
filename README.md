# code-remote-control

A web app for managing Docker containers that run opencode remote control instances.

## Prerequisites

- Docker
- GitHub token for repository access

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
    "docker_networks": ["runner-network"],
    "env_dockerfile": "/configs/Dockerfile",
    "configurations": [
        {
            "name": "gpt-5.3-codex",
            "env": {
                "OPENAI_API_KEY": "sk-..."
            },
            "opencode": {
                "$schema": "https://opencode.ai/config.json",
                "model": "openai/gpt-5.3-codex",
                "small_model": "openai/gpt-5.3-codex",
                "enabled_providers": [
                    "openai"
                ],
                "provider": {
                    "openai": {
                        "npm": "@ai-sdk/openai-compatible",
                        "name": "LiteLLM Proxy",
                        "options": {
                            "baseURL": "http://192.168.1.2:4000/v1",
                            "apiKey": "sk-dud",
                            "timeout": 3600000
                        }
                    }
                }
            }
        }
    ]
}
```

If `env_dockerfile` is set, the image is built locally from that Dockerfile (with `--pull`) on startup instead of pulling from the registry. Mount the Dockerfile into the container to make it accessible (see the volume example below).

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
      - ./Dockerfile.env:/configs/Dockerfile:ro
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - runner-network
    restart: always
```

Note that the runners must be accessible from the CRC server, so must share at least one docker network.
