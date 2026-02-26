# code-remote-control

Example docker config:

Example `config.json`:

```
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