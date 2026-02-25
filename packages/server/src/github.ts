import type { GitHubRepo } from "./types.js";
import { GITHUB_TOKEN } from "./config.js";

export async function fetchRepos(): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
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

  return repos;
}
