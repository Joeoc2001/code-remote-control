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
            "git": {
                "username": "joeoc2001-ai",
                "email": "joeoc2625.ai@gmail.com"
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
      ROOT_DOMAIN: example.com
    volumes:
      - ./environments.json:/configs/environments.json:ro
      - /var/run/docker.sock:/var/run/docker.sock
    restart: always
```

