import type { ManagedContainer, EnvironmentConfig, EnvironmentsFile, GitHubRepo, GitLabRepo, RepoSource } from "./types";

const BASE = "/api";

export async function fetchContainers(): Promise<ManagedContainer[]> {
  const res = await fetch(`${BASE}/containers`);
  if (!res.ok) throw new Error("Failed to fetch containers");
  return res.json();
}

export async function createContainer(
  configName: string,
  repoFullName: string,
  repoSource: RepoSource = "github"
): Promise<ManagedContainer> {
  const res = await fetch(`${BASE}/containers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configName, repoFullName, repoSource }),
  });
  if (!res.ok) throw new Error("Failed to create container");
  return res.json();
}

export async function deleteContainer(id: string): Promise<void> {
  const res = await fetch(`${BASE}/containers/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete container");
}

export async function deleteAllContainers(): Promise<void> {
  const res = await fetch(`${BASE}/containers`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete all containers");
}

export async function fetchConfigs(): Promise<EnvironmentConfig[]> {
  const res = await fetch(`${BASE}/configs`);
  if (!res.ok) throw new Error("Failed to fetch configs");
  const data = await res.json();
  return data.configurations;
}

export async function fetchIframeDomain(): Promise<string | undefined> {
  const res = await fetch(`${BASE}/configs`);
  if (!res.ok) throw new Error("Failed to fetch configs");
  const data: EnvironmentsFile = await res.json();
  return data.iframeDomain;
}

export async function fetchGitHubRepos(): Promise<GitHubRepo[]> {
  const res = await fetch(`${BASE}/github/repos`);
  if (!res.ok) throw new Error("Failed to fetch repos");
  const data = await res.json();
  return data.repos;
}

export async function fetchGitLabRepos(): Promise<{ repos: GitLabRepo[]; configured: boolean }> {
  const res = await fetch(`${BASE}/gitlab/repos`);
  if (!res.ok) throw new Error("Failed to fetch GitLab repos");
  return res.json();
}

export async function fetchBuildInfo(): Promise<{ buildId: string }> {
  const res = await fetch(`${BASE}/build-info`);
  if (!res.ok) throw new Error("Failed to fetch build info");
  return res.json();
}

export function subscribeToEvents(
  onContainerUpdated: (container: ManagedContainer) => void,
  onContainerRemoved: (id: string) => void,
  onReconnect?: () => void,
  onConnectionError?: (connected: boolean) => void,
): () => void {
  const eventSource = new EventSource(`${BASE}/events`);
  let wasConnected = false;

  eventSource.addEventListener("container-updated", (event) => {
    const container = JSON.parse(event.data) as ManagedContainer;
    onContainerUpdated(container);
  });

  eventSource.addEventListener("container-removed", (event) => {
    const { id } = JSON.parse(event.data) as { id: string };
    onContainerRemoved(id);
  });

  eventSource.onopen = () => {
    onConnectionError?.(true);
    if (wasConnected && onReconnect) {
      onReconnect();
    }
    wasConnected = true;
  };

  eventSource.onerror = () => {
    onConnectionError?.(false);
  };

  return () => eventSource.close();
}
