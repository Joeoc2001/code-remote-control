This is a repo for a web app which lets me manage containers for running opencode remote instances on my home PC. It is built with Node/Express/React/Tailwind and integrates with both Docker and GitHub.

## Functionality

This app functions as a wrapper around Docker to spawn containers which each contain an instance of OpenCode's web interface.

## Repo setup

The repo is composed of 2 docker container definitions:
- `env` describes the container which is spun up for each opencode instance, providing devtools and a sandbox;
- `app` gives the webserver.

These can both be found in `./docker`.

The remainder of the TS code is in `./packages`.

# Repo rules:
- Do not add superfluous comments. Your code should be self-documenting — ideally your code should contain no comments at all.
- Always prefer to fail fast and fail loudly over recovering from errors.
- The code is not licensed, and especially not under MIT. 
- We are the only user of the API — do not be afraid to change endpoint names and schemas.
