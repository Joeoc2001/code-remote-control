import type { RepoReviewRequest, RepoWorkItem } from "./types.js";

export const ISSUE_PROMPT_SUFFIX = "Ensure your implementation is thoroughly tested and is clearly correct from the test output. If you struggle to complete this in its entirety for any reason, including the task being too large, comment your findings and then stop.";

export const FORGE_BODY_PROMPT_SUFFIX = "When posting a PR/MR description or comment, never pass `@-` or `-` as the body value: `glab mr create --description`, `glab mr update --description`, `glab mr note -m` and `gh pr create --body` post the string you hand them verbatim, so `@-` reaches the forge as the literal two characters and the body you meant to send is lost. Write multi-line bodies to a file and pass them with a mechanism the command actually supports: `--body-file body.md` for gh, `--description \"$(cat body.md)\"` or `-m \"$(cat body.md)\"` for glab, or `glab api ... -F 'description=@body.md'`.";

export function reviewRequestNoun(item: Pick<RepoReviewRequest, "kind">): string {
  return item.kind === "merge_request" ? "merge request" : "pull request";
}

export function buildIssuePrompt(item: RepoWorkItem): string {
  return `Address issue ${item.reference} at ${item.url}. ${ISSUE_PROMPT_SUFFIX} ${FORGE_BODY_PROMPT_SUFFIX}`;
}

export function buildTaskImplementPrompt(item: RepoWorkItem): string {
  return `Address issue ${item.reference} at ${item.url}. Commit your work to a new branch, push it, and open a pull/merge request for it — the deliverable is an open pull/merge request, and the task is incomplete without one. ${ISSUE_PROMPT_SUFFIX} ${FORGE_BODY_PROMPT_SUFFIX}`;
}

export function buildReviewRequestPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  const noun = reviewRequestNoun(item);
  return `Review ${noun} ${item.reference} at ${item.url}. Only open resolvable discussion threads for changes that genuinely must be made before merge — every unresolved thread blocks the merge automation and spawns a follow-up agent. If changes are required, open threads for the must-fix items only and put any minor non-blocking suggestions in a plain comment alongside them. If the ${noun} is acceptable to merge as-is, post your verdict together with any minor non-blocking suggestions as a single plain comment: not a resolvable thread, and not a review that requires resolution. ${FORGE_BODY_PROMPT_SUFFIX}`;
}

export function buildReviewCommentsPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Address all open comments on ${reviewRequestNoun(item)} ${item.reference} at ${item.url}, closing comments as they are resolved. ${FORGE_BODY_PROMPT_SUFFIX}`;
}

export function buildRebasePrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Rebase ${reviewRequestNoun(item)} ${item.reference} at ${item.url} onto the main branch, resolving any merge conflicts, and force-push the rebased branch. ${FORGE_BODY_PROMPT_SUFFIX}`;
}

export function buildFixCiPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Investigate the failing CI on ${reviewRequestNoun(item)} ${item.reference} at ${item.url} and push fixes to its branch until CI passes. ${FORGE_BODY_PROMPT_SUFFIX}`;
}
