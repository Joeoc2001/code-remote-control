import type { GitLabRepo } from "./types.js";
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
