# Claude Code agent memory

## Posting descriptions and comments to GitHub

When you post a pull request description or a comment, never pass `@-`, `@` or `-` as the body value: gh reads a body from stdin only via `--body-file -` or a raw `gh api -F body=@-`, so `--body @-` posts those two characters literally and the body you wrote is lost. Write the body to a temporary file and pass it with `gh pr create --body-file body.md`, `gh pr comment --body-file body.md`, or `gh api ... -F body=@body.md`. Never leave a description or comment body empty, and re-read what you posted to confirm the body arrived intact.

## Posting descriptions and comments to GitLab

When you post a merge request description or a comment, never pass `@-`, `@` or `-` as the body value: the glab porcelain commands (`glab mr create --description`, `glab mr update --description`, `glab mr note -m`) do not read the body from stdin — only raw API calls such as `glab api -F 'description=@-'` do — so they post those characters literally and the body you wrote is lost. Write the body to a temporary file and pass it with `glab mr create --description "$(cat body.md)"`, `glab mr note -m "$(cat body.md)"`, or `glab api ... -F 'description=@body.md'`. Never leave a description or comment body empty, and re-read what you posted to confirm the body arrived intact.
