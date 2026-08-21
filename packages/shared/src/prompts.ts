import type { RepoReviewRequest, RepoWorkItem } from "./types.js";

export const ISSUE_PROMPT_SUFFIX = "Ensure your implementation is thoroughly tested and is clearly correct from the test output. If you struggle to complete this in its entirety for any reason, including the task being too large, comment your findings and then stop.";

export function reviewRequestNoun(item: Pick<RepoReviewRequest, "kind">): string {
  return item.kind === "merge_request" ? "merge request" : "pull request";
}

export function buildIssuePrompt(item: RepoWorkItem): string {
  return `Address issue ${item.reference} at ${item.url}. ${ISSUE_PROMPT_SUFFIX}`;
}

export function buildTaskImplementPrompt(item: RepoWorkItem): string {
  return `Address issue ${item.reference} at ${item.url}. Commit your work to a new branch, push it, and open a pull/merge request for it — the deliverable is an open pull/merge request, and the task is incomplete without one. ${ISSUE_PROMPT_SUFFIX}`;
}

export function buildReviewRequestPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Review ${reviewRequestNoun(item)} ${item.reference} at ${item.url}, leaving comments with suggestions and recommendations.`;
}

export function buildReviewCommentsPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Address all open comments on ${reviewRequestNoun(item)} ${item.reference} at ${item.url}, closing comments as they are resolved.`;
}

export function buildRebasePrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Rebase ${reviewRequestNoun(item)} ${item.reference} at ${item.url} onto the main branch, resolving any merge conflicts, and force-push the rebased branch.`;
}

export function buildFixCiPrompt(item: Pick<RepoReviewRequest, "kind" | "reference" | "url">): string {
  return `Investigate the failing CI on ${reviewRequestNoun(item)} ${item.reference} at ${item.url} and push fixes to its branch until CI passes.`;
}
