import type { RepoReviewRequest, RepoSource, RepoWorkItem } from "../types.js";
import {
  fetchOpenIssues,
  fetchOpenPullRequests,
  fetchPullRequest,
  mergePullRequest,
  rebasePullRequest,
} from "./github.js";
import {
  fetchMergeRequest,
  fetchOpenIssuesAndWorkItems,
  fetchOpenMergeRequests,
  mergeMergeRequest,
  rebaseMergeRequest,
} from "./gitlab.js";

export interface Forge {
  listWorkItems(repoFullName: string): Promise<RepoWorkItem[]>;
  listReviewRequests(repoFullName: string): Promise<RepoReviewRequest[]>;
  getReviewRequest(repoFullName: string, id: string): Promise<RepoReviewRequest>;
  rebase(repoFullName: string, id: string): Promise<void>;
  merge(repoFullName: string, id: string): Promise<void>;
}

const githubForge: Forge = {
  listWorkItems: fetchOpenIssues,
  listReviewRequests: fetchOpenPullRequests,
  getReviewRequest: fetchPullRequest,
  rebase: rebasePullRequest,
  merge: mergePullRequest,
};

const gitlabForge: Forge = {
  listWorkItems: fetchOpenIssuesAndWorkItems,
  listReviewRequests: fetchOpenMergeRequests,
  getReviewRequest: fetchMergeRequest,
  rebase: rebaseMergeRequest,
  merge: mergeMergeRequest,
};

export function getForge(source: RepoSource): Forge {
  return source === "gitlab" ? gitlabForge : githubForge;
}
