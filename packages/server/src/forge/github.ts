import type {
  GitHubRepo,
  RepoReviewRequest,
  RepoWorkItem,
  ReviewRequestCiState,
  ReviewRequestState,
} from "../types.js";
import { GITHUB_TOKEN, loadConfigurations } from "../config.js";

const MAX_PAGES = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;
const GRAPHQL_ACCEPT = "application/vnd.github.merge-info-preview+json";

let repoCache: { repos: GitHubRepo[]; fetchedAt: number } | null = null;
let viewerLoginPromise: Promise<string> | null = null;

export async function fetchRepos(): Promise<GitHubRepo[]> {
  if (repoCache && Date.now() - repoCache.fetchedAt < CACHE_TTL_MS) {
    return repoCache.repos;
  }

  const repos: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= MAX_PAGES) {
    const response = await fetch(
      `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=updated`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{
      full_name: string;
      description: string | null;
      private: boolean;
      default_branch: string;
    }>;

    if (data.length === 0) break;

    for (const repo of data) {
      repos.push({
        fullName: repo.full_name,
        description: repo.description,
        private: repo.private,
        defaultBranch: repo.default_branch,
      });
    }

    if (data.length < perPage) break;
    page++;
  }

  repoCache = { repos, fetchedAt: Date.now() };
  return repos;
}

export async function fetchOpenIssues(repoFullName: string): Promise<RepoWorkItem[]> {
  const items: RepoWorkItem[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= MAX_PAGES) {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/issues?state=open&per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{
      number: number;
      title: string;
      html_url: string;
      body: string | null;
      pull_request?: unknown;
    }>;

    if (data.length === 0) break;

    for (const issue of data) {
      if (issue.pull_request) continue;
      items.push({
        id: String(issue.number),
        reference: `#${issue.number}`,
        title: issue.title,
        url: issue.html_url,
        body: issue.body,
        kind: "issue",
      });
    }

    if (data.length < perPage) break;
    page++;
  }

  return items;
}

export interface GitHubPullRequestNode {
  number: number;
  title: string;
  url: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefOid: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  commits: {
    nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }>;
  };
  reviewThreads: {
    nodes: Array<{ isResolved: boolean }>;
  };
  latestOpinionatedReviews: {
    nodes: Array<{ state: string; author: { login: string } | null }>;
  };
}

const PULL_REQUEST_FIELDS = `
  number
  title
  url
  body
  state
  headRefOid
  mergeable
  mergeStateStatus
  commits(last: 1) {
    nodes { commit { statusCheckRollup { state } } }
  }
  reviewThreads(first: 100) {
    nodes { isResolved }
  }
  latestOpinionatedReviews(first: 100) {
    nodes { state author { login } }
  }
`;

const PULL_REQUESTS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PULL_REQUEST_FIELDS} }
    }
  }
}`;

const PULL_REQUEST_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PULL_REQUEST_FIELDS} }
  }
}`;

const VIEWER_QUERY = `query { viewer { login } }`;

async function githubGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: GRAPHQL_ACCEPT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as { errors?: Array<{ message: string }>; data?: T };

  if (result.errors && result.errors.length > 0) {
    throw new Error(`GitHub GraphQL error: ${result.errors.map((e) => e.message).join("; ")}`);
  }

  if (result.data === undefined) {
    throw new Error("GitHub GraphQL error: response contained no data");
  }

  return result.data;
}

async function fetchViewerLogin(): Promise<string> {
  if (!viewerLoginPromise) {
    viewerLoginPromise = githubGraphql<{ viewer: { login: string } }>(VIEWER_QUERY, {}).then(
      (data) => data.viewer.login,
    );
    viewerLoginPromise.catch(() => {
      viewerLoginPromise = null;
    });
  }
  return viewerLoginPromise;
}

export function mapGitHubCiState(rollupState: string | null): ReviewRequestCiState {
  if (rollupState === null) return "none";
  switch (rollupState) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failed";
    case "EXPECTED":
    case "PENDING":
      return "running";
    default:
      throw new Error(`Unknown GitHub status check rollup state: ${rollupState}`);
  }
}

export function mapGitHubState(state: GitHubPullRequestNode["state"]): ReviewRequestState {
  switch (state) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      throw new Error(`Unknown GitHub pull request state: ${String(state)}`);
  }
}

export function mapPullRequestNode(node: GitHubPullRequestNode, viewerLogin: string): RepoReviewRequest {
  const rollupState = node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
  return {
    id: String(node.number),
    reference: `#${node.number}`,
    title: node.title,
    url: node.url,
    body: node.body || null,
    kind: "pull_request",
    state: mapGitHubState(node.state),
    headSha: node.headRefOid,
    ciState: mapGitHubCiState(rollupState),
    hasConflicts: node.mergeable === "CONFLICTING",
    needsRebase: node.mergeStateStatus === "BEHIND",
    mergeStateKnown: node.mergeable !== "UNKNOWN" && node.mergeStateStatus !== "UNKNOWN",
    approvedByHuman: node.latestOpinionatedReviews.nodes.some(
      (review) => review.state === "APPROVED" && review.author !== null && review.author.login !== viewerLogin,
    ),
    hasUnresolvedComments: node.reviewThreads.nodes.some((thread) => !thread.isResolved),
  };
}

interface PullRequestsPage {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: GitHubPullRequestNode[];
    };
  } | null;
}

export async function fetchOpenPullRequests(repoFullName: string): Promise<RepoReviewRequest[]> {
  const [owner, name] = repoFullName.split("/");
  const viewerLogin = await fetchViewerLogin();
  const items: RepoReviewRequest[] = [];
  let cursor: string | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data: PullRequestsPage = await githubGraphql<PullRequestsPage>(PULL_REQUESTS_QUERY, {
      owner,
      name,
      cursor,
    });

    if (!data.repository) {
      throw new Error(`GitHub repository not found: ${repoFullName}`);
    }

    const { pageInfo, nodes } = data.repository.pullRequests;

    for (const pullRequest of nodes) {
      items.push(mapPullRequestNode(pullRequest, viewerLogin));
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return items;
}

export async function fetchPullRequest(repoFullName: string, id: string): Promise<RepoReviewRequest> {
  const [owner, name] = repoFullName.split("/");
  const viewerLogin = await fetchViewerLogin();

  const data = await githubGraphql<{
    repository: { pullRequest: GitHubPullRequestNode | null } | null;
  }>(PULL_REQUEST_QUERY, { owner, name, number: parseInt(id, 10) });

  if (!data.repository?.pullRequest) {
    throw new Error(`GitHub pull request not found: ${repoFullName}#${id}`);
  }

  return mapPullRequestNode(data.repository.pullRequest, viewerLogin);
}

async function githubRest(method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}: ${detail}`);
  }
}

export async function rebasePullRequest(repoFullName: string, id: string): Promise<void> {
  await githubRest("PUT", `/repos/${repoFullName}/pulls/${id}/update-branch`);
}

export async function mergePullRequest(repoFullName: string, id: string): Promise<void> {
  const config = await loadConfigurations();
  await githubRest("PUT", `/repos/${repoFullName}/pulls/${id}/merge`, {
    merge_method: config.merge_method ?? "merge",
  });
}
