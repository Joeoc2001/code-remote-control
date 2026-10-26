import type { RepoReviewRequest, RepoSource, RepoWorkItem } from "../types.js";
import {
  approvePullRequest,
  fetchOpenIssues,
  fetchOpenPullRequests,
  fetchPullRequest,
  fetchPullRequestDiffHash,
  mergePullRequest,
  rebasePullRequest,
  unapprovePullRequest,
} from "./github.js";
import {
  approveMergeRequest,
  fetchMergeRequest,
  fetchMergeRequestDiffHash,
  fetchOpenIssuesAndWorkItems,
  fetchOpenMergeRequests,
  mergeMergeRequest,
  rebaseMergeRequest,
  unapproveMergeRequest,
} from "./gitlab.js";

export interface Forge {
  listWorkItems(repoFullName: string): Promise<RepoWorkItem[]>;
  listReviewRequests(repoFullName: string): Promise<RepoReviewRequest[]>;
  getReviewRequest(repoFullName: string, id: string): Promise<RepoReviewRequest>;
  getDiffHash(repoFullName: string, id: string): Promise<string | null>;
  rebase(repoFullName: string, id: string): Promise<void>;
  approve(repoFullName: string, id: string, headSha: string): Promise<void>;
  unapprove(repoFullName: string, id: string): Promise<void>;
  merge(repoFullName: string, id: string): Promise<void>;
}

const githubForge: Forge = {
  listWorkItems: fetchOpenIssues,
  listReviewRequests: fetchOpenPullRequests,
  getReviewRequest: fetchPullRequest,
  getDiffHash: fetchPullRequestDiffHash,
  rebase: rebasePullRequest,
  approve: approvePullRequest,
  unapprove: unapprovePullRequest,
  merge: mergePullRequest,
};

const gitlabForge: Forge = {
  listWorkItems: fetchOpenIssuesAndWorkItems,
  listReviewRequests: fetchOpenMergeRequests,
  getReviewRequest: fetchMergeRequest,
  getDiffHash: fetchMergeRequestDiffHash,
  rebase: rebaseMergeRequest,
  approve: approveMergeRequest,
  unapprove: unapproveMergeRequest,
  merge: mergeMergeRequest,
};

export function getForge(source: RepoSource): Forge {
  return source === "gitlab" ? gitlabForge : githubForge;
}
