import type { GitLabRepo, RepoWorkItem } from "./types.js";
import { GITLAB_TOKEN, loadConfigurations } from "./config.js";

const MAX_PAGES = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;

let repoCache: { repos: GitLabRepo[]; fetchedAt: number } | null = null;

export function isGitLabConfigured(): boolean {
  return GITLAB_TOKEN.length > 0;
}

export async function fetchRepos(): Promise<GitLabRepo[]> {
  if (!isGitLabConfigured()) return [];

  if (repoCache && Date.now() - repoCache.fetchedAt < CACHE_TTL_MS) {
    return repoCache.repos;
  }

  const config = await loadConfigurations();
  const gitlabUrl = config.gitlab_url || "https://gitlab.com";

  const repos: GitLabRepo[] = [];
  let page = 1;
  const perPage = 100;
  const apiBase = gitlabUrl.replace(/\/+$/, "");

  while (page <= MAX_PAGES) {
    const response = await fetch(
      `${apiBase}/api/v4/projects?membership=true&per_page=${perPage}&page=${page}&order_by=updated_at`,
      {
        headers: {
          "PRIVATE-TOKEN": GITLAB_TOKEN,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }

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
  const config = await loadConfigurations();
  const gitlabUrl = config.gitlab_url || "https://gitlab.com";
  const apiBase = gitlabUrl.replace(/\/+$/, "");
  const encodedProject = encodeURIComponent(repoFullName);
  const items: RepoWorkItem[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= MAX_PAGES) {
    const response = await fetch(
      `${apiBase}/api/v4/projects/${encodedProject}/${endpoint}?state=opened&per_page=${perPage}&page=${page}`,
      {
        headers: {
          "PRIVATE-TOKEN": GITLAB_TOKEN,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
    }

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
  const [issues, workItems] = await Promise.all([
    fetchGitLabItems(repoFullName, "issues"),
    fetchGitLabItems(repoFullName, "work_items"),
  ]);

  const seenUrls = new Set<string>();
  return [...issues, ...workItems].filter((item) => {
    if (seenUrls.has(item.url)) return false;
    seenUrls.add(item.url);
    return true;
  });
}
