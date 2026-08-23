import type { RepoReviewRequest, RepoSource, RepoWorkItem } from "../types.js";
import {
  fetchOpenIssues,
  fetchOpenPullRequests,
  fetchPullRequest,
  fetchPullRequestDiffHash,
  mergePullRequest,
  rebasePullRequest,
} from "./github.js";
import {
  fetchMergeRequest,
  fetchMergeRequestDiffHash,
  fetchOpenIssuesAndWorkItems,
  fetchOpenMergeRequests,
  mergeMergeRequest,
  rebaseMergeRequest,
} from "./gitlab.js";

export interface Forge {
  listWorkItems(repoFullName: string): Promise<RepoWorkItem[]>;
  listReviewRequests(repoFullName: string): Promise<RepoReviewRequest[]>;
  getReviewRequest(repoFullName: string, id: string): Promise<RepoReviewRequest>;
  getDiffHash(repoFullName: string, id: string): Promise<string>;
  rebase(repoFullName: string, id: string): Promise<void>;
  merge(repoFullName: string, id: string): Promise<void>;
}

const githubForge: Forge = {
  listWorkItems: fetchOpenIssues,
  listReviewRequests: fetchOpenPullRequests,
  getReviewRequest: fetchPullRequest,
  getDiffHash: fetchPullRequestDiffHash,
  rebase: rebasePullRequest,
  merge: mergePullRequest,
};

const gitlabForge: Forge = {
  listWorkItems: fetchOpenIssuesAndWorkItems,
  listReviewRequests: fetchOpenMergeRequests,
  getReviewRequest: fetchMergeRequest,
  getDiffHash: fetchMergeRequestDiffHash,
  rebase: rebaseMergeRequest,
  merge: mergeMergeRequest,
};

export function getForge(source: RepoSource): Forge {
  return source === "gitlab" ? gitlabForge : githubForge;
}
