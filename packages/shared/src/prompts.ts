import type { RepoReviewRequest, RepoSource, RepoWorkItem } from "./types.js";

export const ISSUE_PROMPT_SUFFIX = "Ensure your implementation is thoroughly tested and is clearly correct from the test output. If you struggle to complete this in its entirety for any reason, including the task being too large, comment your findings and then stop.";

const GITHUB_BODY_GUIDANCE = "When you post a pull request description or a comment, never pass `@-`, `@` or `-` as the body value: gh reads a body from stdin only via `--body-file -` or a raw `gh api -F body=@-`, so `--body @-` posts those two characters literally and the body you wrote is lost. Write the body to a temporary file and pass it with `gh pr create --body-file body.md`, `gh pr comment --body-file body.md`, or `gh api ... -F body=@body.md`. Never leave a description or comment body empty, and re-read what you posted to confirm the body arrived intact.";

const GITLAB_BODY_GUIDANCE = "When you post a merge request description or a comment, never pass `@-`, `@` or `-` as the body value: the glab porcelain commands (`glab mr create --description`, `glab mr update --description`, `glab mr note -m`) do not read the body from stdin — only raw API calls such as `glab api -F \'description=@-\'` do — so they post those characters literally and the body you wrote is lost. Write the body to a temporary file and pass it with `glab mr create --description \"$(cat body.md)\"`, `glab mr note -m \"$(cat body.md)\"`, or `glab api ... -F \'description=@body.md\'`. Never leave a description or comment body empty, and re-read what you posted to confirm the body arrived intact.";

export function forgeBodyGuidance(source: RepoSource): string {
  return source === "gitlab" ? GITLAB_BODY_GUIDANCE : GITHUB_BODY_GUIDANCE;
}

function reviewRequestBodyGuidance(item: Pick<RepoReviewRequest, "kind">): string {
  return forgeBodyGuidance(item.kind === "merge_request" ? "gitlab" : "github");
}

export function reviewRequestNoun(item: Pick<RepoReviewRequest, "kind">): string {
  return item.kind === "merge_request" ? "merge request" : "pull request";
}

export function buildIssuePrompt(item: RepoWorkItem): string {
  return `Address issue ${item.reference} at ${item.url}. ${ISSUE_PROMPT_SUFFIX}`;
}

export const CREATED_ISSUE_URL_PATH = "/run/crc-created-issue-url";

export function buildCreateIssuePrompt(text: string, source: RepoSource): string {
  const noun = source === "gitlab" ? "issue or work item" : "issue";
  const bodyCommand =
    source === "gitlab" ? '`glab issue create --description "$(cat body.md)"`' : "`gh issue create --body-file body.md`";
  return `Explore the codebase and open an ${noun} with your findings and a plan for the request below. Do not implement the request — the deliverable is the open ${noun}, containing what you learned from the codebase and a concrete implementation plan. Once it is open, write its URL (and nothing else) to ${CREATED_ISSUE_URL_PATH}; the task is incomplete until that file holds the URL. Write the ${noun} body to a temporary file and pass it with ${bodyCommand} — never pass \`@-\`, \`@\` or \`-\` as the body value, never leave the body empty, and re-read what you posted to confirm the body arrived intact.\n\nRequest:\n${text}`;
}

export function buildTaskImplementPrompt(item: RepoWorkItem, source: RepoSource): string {
  return `Address issue ${item.reference} at ${item.url}. Commit your work to a new branch, push it, and open a pull/merge request for it — the deliverable is an open pull/merge request, and the task is incomplete without one. ${ISSUE_PROMPT_SUFFIX} ${forgeBodyGuidance(source)}`;
}

export function buildReviewRequestPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  const noun = reviewRequestNoun(item);
  return `Review ${noun} ${item.reference} at ${item.url}. Only open resolvable discussion threads for changes that genuinely must be made before merge — every unresolved thread blocks the merge automation and spawns a follow-up agent. If changes are required, open threads for the must-fix items only and put any minor non-blocking suggestions in a plain comment alongside them. If the ${noun} is acceptable to merge as-is, post your verdict together with any minor non-blocking suggestions as a single plain comment: not a resolvable thread, and not a review that requires resolution. ${reviewRequestBodyGuidance(item)}`;
}

export function buildReviewCommentsPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Address all open comments on ${reviewRequestNoun(item)} ${item.reference} at ${item.url}, closing comments as they are resolved. ${reviewRequestBodyGuidance(item)}`;
}

export function buildRebasePrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Rebase ${reviewRequestNoun(item)} ${item.reference} at ${item.url} onto the main branch, resolving any merge conflicts, and force-push the rebased branch. ${reviewRequestBodyGuidance(item)}`;
}

export function buildFixCiPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Investigate the failing CI on ${reviewRequestNoun(item)} ${item.reference} at ${item.url} and push fixes to its branch until CI passes. ${reviewRequestBodyGuidance(item)}`;
}
