import { isPlaceholderBody } from "@crc/shared/bodies";
import type {
  GitLabRepo,
  RepoReviewRequest,
  RepoWorkItem,
  ReviewRequestCiState,
  ReviewRequestState,
} from "../types.js";
import { GITLAB_TOKEN, loadConfigurations } from "../config.js";

const MAX_PAGES = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;

let repoCache: { repos: GitLabRepo[]; fetchedAt: number } | null = null;
let currentUsernamePromise: Promise<string> | null = null;

export function isGitLabConfigured(): boolean {
  return GITLAB_TOKEN.length > 0;
}

async function gitlabApiBase(): Promise<string> {
  const config = await loadConfigurations();
  const gitlabUrl = config.gitlab_url || "https://gitlab.com";
  return gitlabUrl.replace(/\/+$/, "");
}

async function gitlabRequest(method: string, url: string, body?: unknown): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitLab API error: ${response.status} ${response.statusText}: ${detail}`);
  }

  return response;
}

async function fetchCurrentUsername(): Promise<string> {
  if (!currentUsernamePromise) {
    currentUsernamePromise = (async () => {
      const apiBase = await gitlabApiBase();
      const response = await gitlabRequest("GET", `${apiBase}/api/v4/user`);
      const user = (await response.json()) as { username: string };
      return user.username;
    })();
    currentUsernamePromise.catch(() => {
      currentUsernamePromise = null;
    });
  }
  return currentUsernamePromise;
}

export async function fetchRepos(): Promise<GitLabRepo[]> {
  if (!isGitLabConfigured()) return [];

  if (repoCache && Date.now() - repoCache.fetchedAt < CACHE_TTL_MS) {
    return repoCache.repos;
  }

  const apiBase = await gitlabApiBase();
  const repos: GitLabRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= MAX_PAGES) {
    const response = await gitlabRequest(
      "GET",
      `${apiBase}/api/v4/projects?membership=true&per_page=${perPage}&page=${page}&order_by=updated_at`,
    );

    const data = (await response.json()) as Array<{
      path_with_namespace: string;
      description: string | null;
      visibility: string;
      default_branch: string;
    }>;

    if (data.length === 0) break;

    for (const project of data) {
      repos.push({
        fullName: project.path_with_namespace,
        description: project.description,
        private: project.visibility !== "public",
        defaultBranch: project.default_branch,
      });
    }

    if (data.length < perPage) break;
    page++;
  }

  repoCache = { repos, fetchedAt: Date.now() };
  return repos;
}

async function fetchGitLabItems(
  repoFullName: string,
  endpoint: "issues" | "work_items",
): Promise<RepoWorkItem[]> {
  const apiBase = await gitlabApiBase();
  const encodedProject = encodeURIComponent(repoFullName);
  const items: RepoWorkItem[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= MAX_PAGES) {
    const response = await gitlabRequest(
      "GET",
      `${apiBase}/api/v4/projects/${encodedProject}/${endpoint}?state=opened&per_page=${perPage}&page=${page}`,
    );

    const data = (await response.json()) as Array<{
      id: number;
      iid?: number;
      title: string;
      web_url: string;
      description: string | null;
    }>;

    if (data.length === 0) break;

    for (const item of data) {
      const reference = typeof item.iid === "number" ? `#${item.iid}` : String(item.id);
      items.push({
        id: `${endpoint}:${item.id}`,
        reference,
        title: item.title,
        url: item.web_url,
        body: item.description,
        kind: endpoint === "issues" ? "issue" : "work_item",
      });
    }

    if (data.length < perPage) break;
    page++;
  }

  return items;
}

export async function fetchOpenIssuesAndWorkItems(repoFullName: string): Promise<RepoWorkItem[]> {
  if (!isGitLabConfigured()) return [];
  const issues = await fetchGitLabItems(repoFullName, "issues");
  let workItems: RepoWorkItem[] = [];

  try {
    workItems = await fetchGitLabItems(repoFullName, "work_items");
  } catch (err) {
    console.warn("GitLab work items unavailable:", err);
  }

  const seenUrls = new Set<string>();
  return [...issues, ...workItems].filter((item) => {
    if (seenUrls.has(item.url)) return false;
    seenUrls.add(item.url);
    return true;
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface GitLabDiscussion {
  notes: Array<{ body: string; system: boolean; resolvable: boolean; resolved: boolean }>;
}

export interface DiscussionSummary {
  hasUnresolvedComments: boolean;
  hasPlaceholderComment: boolean;
}

export function summarizeDiscussions(discussions: GitLabDiscussion[]): DiscussionSummary {
  const notes = discussions.flatMap((discussion) => discussion.notes);
  return {
    hasUnresolvedComments: notes.some((note) => note.resolvable && !note.resolved),
    hasPlaceholderComment: notes.some((note) => !note.system && isPlaceholderBody(note.body)),
  };
}

async function fetchDiscussionSummary(
  apiBase: string,
  encodedProject: string,
  mergeRequestIid: number,
): Promise<DiscussionSummary> {
  const summary: DiscussionSummary = { hasUnresolvedComments: false, hasPlaceholderComment: false };
  let page = 1;
  const perPage = 100;

  while (page <= MAX_PAGES) {
    const response = await gitlabRequest(
      "GET",
      `${apiBase}/api/v4/projects/${encodedProject}/merge_requests/${mergeRequestIid}/discussions?per_page=${perPage}&page=${page}`,
    );

    const data = (await response.json()) as GitLabDiscussion[];
    const pageSummary = summarizeDiscussions(data);
    summary.hasUnresolvedComments ||= pageSummary.hasUnresolvedComments;
    summary.hasPlaceholderComment ||= pageSummary.hasPlaceholderComment;

    if (summary.hasUnresolvedComments && summary.hasPlaceholderComment) break;
    if (data.length < perPage) break;
    page++;
  }

  return summary;
}

async function fetchApprovedByHuman(
  apiBase: string,
  encodedProject: string,
  mergeRequestIid: number,
): Promise<boolean> {
  const [response, currentUsername] = await Promise.all([
    gitlabRequest(
      "GET",
      `${apiBase}/api/v4/projects/${encodedProject}/merge_requests/${mergeRequestIid}/approvals`,
    ),
    fetchCurrentUsername(),
  ]);

  const approvals = (await response.json()) as {
    approved_by: Array<{ user: { username: string } }>;
  };

  return approvals.approved_by.some((entry) => entry.user.username !== currentUsername);
}

export interface GitLabMergeRequestDetail {
  iid: number;
  title: string;
  web_url: string;
  description: string | null;
  state: string;
  sha: string;
  has_conflicts: boolean;
  diverged_commits_count?: number;
  detailed_merge_status?: string;
  merge_status?: string;
  head_pipeline: { status: string } | null;
}

export function mapGitLabCiState(pipelineStatus: string | null): ReviewRequestCiState {
  if (pipelineStatus === null) return "none";
  switch (pipelineStatus) {
    case "created":
    case "waiting_for_resource":
    case "waiting_for_callback":
    case "preparing":
    case "pending":
    case "scheduled":
      return "pending";
    case "running":
      return "running";
    case "success":
      return "success";
    case "failed":
    case "canceled":
    case "canceling":
      return "failed";
    case "skipped":
    case "manual":
      return "none";
    default:
      throw new Error(`Unknown GitLab pipeline status: ${pipelineStatus}`);
  }
}

export function mapGitLabState(state: string): ReviewRequestState {
  switch (state) {
    case "opened":
    case "locked":
      return "open";
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      throw new Error(`Unknown GitLab merge request state: ${state}`);
  }
}

const UNSETTLED_MERGE_STATUSES = new Set(["checking", "unchecked", "preparing", "approvals_syncing"]);

export function mapMergeRequestDetail(
  detail: GitLabMergeRequestDetail,
  discussions: DiscussionSummary,
  approvedByHuman: boolean,
): RepoReviewRequest {
  const mergeStatus = detail.detailed_merge_status ?? detail.merge_status ?? "unchecked";
  return {
    id: String(detail.iid),
    reference: `!${detail.iid}`,
    title: detail.title,
    url: detail.web_url,
    body: detail.description,
    kind: "merge_request",
    state: mapGitLabState(detail.state),
    headSha: detail.sha,
    ciState: mapGitLabCiState(detail.head_pipeline?.status ?? null),
    hasConflicts: detail.has_conflicts,
    needsRebase: (detail.diverged_commits_count ?? 0) > 0,
    mergeStateKnown: !UNSETTLED_MERGE_STATUSES.has(mergeStatus),
    approvedByHuman,
    hasUnresolvedComments: discussions.hasUnresolvedComments,
    hasPlaceholderComment: discussions.hasPlaceholderComment,
  };
}

async function buildMergeRequest(
  apiBase: string,
  encodedProject: string,
  mergeRequestIid: number,
): Promise<RepoReviewRequest> {
  const [detailResponse, discussions, approvedByHuman] = await Promise.all([
    gitlabRequest(
      "GET",
      `${apiBase}/api/v4/projects/${encodedProject}/merge_requests/${mergeRequestIid}?include_diverged_commits_count=true`,
    ),
    fetchDiscussionSummary(apiBase, encodedProject, mergeRequestIid),
    fetchApprovedByHuman(apiBase, encodedProject, mergeRequestIid),
  ]);

  const detail = (await detailResponse.json()) as GitLabMergeRequestDetail;
  return mapMergeRequestDetail(detail, discussions, approvedByHuman);
}

export async function fetchOpenMergeRequests(repoFullName: string): Promise<RepoReviewRequest[]> {
  if (!isGitLabConfigured()) return [];

  const apiBase = await gitlabApiBase();
  const encodedProject = encodeURIComponent(repoFullName);
  const items: RepoReviewRequest[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= MAX_PAGES) {
    const response = await gitlabRequest(
      "GET",
      `${apiBase}/api/v4/projects/${encodedProject}/merge_requests?state=opened&with_merge_status_recheck=true&per_page=${perPage}&page=${page}`,
    );

    const data = (await response.json()) as Array<{ iid: number }>;

    if (data.length === 0) break;

    const built = await mapWithConcurrency(data, 10, (mergeRequest) =>
      buildMergeRequest(apiBase, encodedProject, mergeRequest.iid),
    );
    items.push(...built);

    if (data.length < perPage) break;
    page++;
  }

  return items;
}

export async function fetchMergeRequest(repoFullName: string, id: string): Promise<RepoReviewRequest> {
  const apiBase = await gitlabApiBase();
  const encodedProject = encodeURIComponent(repoFullName);
  return buildMergeRequest(apiBase, encodedProject, parseInt(id, 10));
}

export async function rebaseMergeRequest(repoFullName: string, id: string): Promise<void> {
  const apiBase = await gitlabApiBase();
  const encodedProject = encodeURIComponent(repoFullName);
  await gitlabRequest("PUT", `${apiBase}/api/v4/projects/${encodedProject}/merge_requests/${id}/rebase`);
}

export async function mergeMergeRequest(repoFullName: string, id: string): Promise<void> {
  const config = await loadConfigurations();
  const apiBase = await gitlabApiBase();
  const encodedProject = encodeURIComponent(repoFullName);
  await gitlabRequest(
    "PUT",
    `${apiBase}/api/v4/projects/${encodedProject}/merge_requests/${id}/merge`,
    config.merge_method === "squash" ? { squash: true } : undefined,
  );
}
