import type { GitHubRepo, RepoWorkItem } from "./types.js";
import { GITHUB_TOKEN } from "./config.js";

const MAX_PAGES = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;

let repoCache: { repos: GitHubRepo[]; fetchedAt: number } | null = null;

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
