import type { RepoSource } from "./types.js";

const VALID_REPO_SOURCES: RepoSource[] = ["github", "gitlab"];
const GITHUB_REPO_NAME_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const GITLAB_REPO_NAME_RE = /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+$/;

export function isValidContainerId(id: string): boolean {
  return /^[a-f0-9]+$/.test(id) && id.length >= 12 && id.length <= 64;
}

export function isValidRepoSource(value: unknown): value is RepoSource {
  return typeof value === "string" && VALID_REPO_SOURCES.includes(value as RepoSource);
}

export function getRepoNameError(repoFullName: string, repoSource: RepoSource): string | null {
  if (repoSource === "github") {
    return GITHUB_REPO_NAME_RE.test(repoFullName) ? null : "GitHub repoFullName must be in owner/repo format";
  }

  return GITLAB_REPO_NAME_RE.test(repoFullName) ? null : "GitLab repoFullName must be in namespace/repo format";
}

export function parseRepo(
  repoSource: unknown,
  repoFullName: unknown,
): { error: string } | { repoSource: RepoSource; repoFullName: string } {
  if (typeof repoFullName !== "string" || repoFullName === "") {
    return { error: "repoFullName is required" };
  }
  if (!isValidRepoSource(repoSource)) {
    return { error: "repoSource must be 'github' or 'gitlab'" };
  }
  const repoNameError = getRepoNameError(repoFullName, repoSource);
  if (repoNameError) return { error: repoNameError };
  return { repoSource, repoFullName };
}
