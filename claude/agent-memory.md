# Posting bodies to GitHub and GitLab

`@-` and `-` mean "read this value from stdin" in only a handful of places: `gh api -F body=@-`, `glab api -F 'description=@-'`, `curl -d @-`, and `gh`'s `--body-file -`. Every other flag posts the string it is given verbatim.

Never pass `@-` or `-` as a PR/MR description or comment body. `glab mr create --description`, `glab mr update --description`, `glab mr note -m` and `gh pr create --body` do not interpret `@` syntax, so `@-` is published as the literal two characters and the body you meant to send is lost.

Write multi-line bodies to a file and pass them with a mechanism the command actually supports:

```sh
gh pr create --title "..." --body-file body.md
glab mr create --title "..." --description "$(cat body.md)"
glab mr note 12 -m "$(cat body.md)"
glab api projects/:id/merge_requests/12 -X PUT -F 'description=@body.md'
```
