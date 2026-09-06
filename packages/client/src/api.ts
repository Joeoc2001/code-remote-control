import type {
  ManagedContainer,
  ConfigSummary,
  CreateTasksRequest,
  CreateTasksResponse,
  GitHubRepo,
  GitLabRepo,
  RepoSource,
  CreateContainersResponse,
  RepoReviewRequest,
  RepoWorkItem,
  ContainerCodeStatus,
  InstanceStatus,
  Task,
  UpdateTaskRequest,
} from "./types";

const BASE = "/api";

export async function fetchContainers(): Promise<ManagedContainer[]> {
  const res = await fetch(`${BASE}/containers`);
  if (!res.ok) throw new Error("Failed to fetch containers");
  return res.json();
}

export async function createContainer(
  configName: string,
  repoFullName: string,
  repoSource: RepoSource = "github",
  initialPrompt?: string,
): Promise<ManagedContainer> {
  const res = await fetch(`${BASE}/containers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configName, repoFullName, repoSource, initialPrompt }),
  });
  if (!res.ok) throw new Error("Failed to create container");
  return res.json();
}

export async function createContainers(
  configName: string,
  repoFullName: string,
  repoSource: RepoSource,
  prompts: string[],
): Promise<CreateContainersResponse> {
  const res = await fetch(`${BASE}/containers/many`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configName, repoFullName, repoSource, prompts }),
  });
  if (!res.ok && res.status !== 207) throw new Error("Failed to create containers");
  return res.json();
}

export async function deleteContainer(id: string): Promise<void> {
  const res = await fetch(`${BASE}/containers/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete container");
}

async function assertBulkDeleteSucceeded(res: Response, what: string): Promise<void> {
  if (res.status === 204) return;
  if (res.status === 207) {
    const { errors } = (await res.json()) as { errors: Array<{ id: string; error: string }> };
    throw new Error(
      `Failed to delete ${errors.length} ${what}: ` + errors.map((e) => `${e.id}: ${e.error}`).join("; "),
    );
  }
  throw new Error(`Failed to delete ${what}`);
}

export async function deleteAllContainers(): Promise<void> {
  const res = await fetch(`${BASE}/containers`, { method: "DELETE" });
  await assertBulkDeleteSucceeded(res, "containers");
}

export async function deleteFinishedContainers(): Promise<void> {
  const res = await fetch(`${BASE}/containers?scope=finished`, { method: "DELETE" });
  await assertBulkDeleteSucceeded(res, "finished containers");
}

export async function fetchConfigs(): Promise<ConfigSummary[]> {
  const res = await fetch(`${BASE}/configs`);
  if (!res.ok) throw new Error("Failed to fetch configs");
  const data = await res.json();
  return data.configurations;
}

export async function fetchIframeDomain(): Promise<string | undefined> {
  const res = await fetch(`${BASE}/root-domain`);
  if (!res.ok) throw new Error("Failed to fetch iframe domain");
  const data: { rootDomain?: string } = await res.json();
  return data.rootDomain;
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

export async function fetchRepoWorkItems(repoFullName: string, repoSource: RepoSource): Promise<RepoWorkItem[]> {
  const params = new URLSearchParams({ repoFullName, repoSource });
  const res = await fetch(`${BASE}/repo-work-items?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch repository work items");
  const data = await res.json();
  return data.items;
}

export async function fetchRepoReviewRequests(repoFullName: string, repoSource: RepoSource): Promise<RepoReviewRequest[]> {
  const params = new URLSearchParams({ repoFullName, repoSource });
  const res = await fetch(`${BASE}/repo-review-requests?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch repository review requests");
  const data = await res.json();
  return data.items;
}

export async function fetchBuildInfo(): Promise<{ buildId: string }> {
  const res = await fetch(`${BASE}/build-info`);
  if (!res.ok) throw new Error("Failed to fetch build info");
  return res.json();
}

export async function fetchContainerCodeStatus(id: string): Promise<ContainerCodeStatus> {
  const res = await fetch(`${BASE}/containers/${id}/code-status`);
  if (!res.ok) throw new Error("Failed to fetch container code status");
  return res.json();
}

export async function fetchContainerInstanceStatus(id: string): Promise<InstanceStatus> {
  const res = await fetch(`${BASE}/containers/${id}/instance-status`);
  if (!res.ok) throw new Error("Failed to fetch container instance status");
  return res.json();
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch(`${BASE}/tasks`);
  if (!res.ok) throw new Error("Failed to fetch tasks");
  return res.json();
}

export async function fetchTask(id: string): Promise<Task> {
  const res = await fetch(`${BASE}/tasks/${id}`);
  if (!res.ok) throw new Error("Failed to fetch task");
  return res.json();
}

export async function createTasks(request: CreateTasksRequest): Promise<CreateTasksResponse> {
  const res = await fetch(`${BASE}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok && res.status !== 207 && res.status !== 409) throw new Error("Failed to create tasks");
  return res.json();
}

export async function updateTask(id: string, patch: UpdateTaskRequest): Promise<Task> {
  const res = await fetch(`${BASE}/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update task");
  return res.json();
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${BASE}/tasks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete task");
}

export async function deleteMergedTasks(): Promise<void> {
  const res = await fetch(`${BASE}/tasks?phase=merged`, { method: "DELETE" });
  await assertBulkDeleteSucceeded(res, "merged tasks");
}

export async function fetchTaskAttemptLog(id: string, attemptIndex: number): Promise<string> {
  const res = await fetch(`${BASE}/tasks/${id}/attempts/${attemptIndex}/log`);
  if (!res.ok) throw new Error("Failed to fetch attempt log");
  const data: { log: string } = await res.json();
  return data.log;
}

export interface EventHandlers {
  onContainerUpdated?: (container: ManagedContainer) => void;
  onContainerRemoved?: (id: string) => void;
  onTaskUpdated?: (task: Task) => void;
  onTaskRemoved?: (id: string) => void;
  onReconnect?: () => void;
  onConnectionError?: (connected: boolean) => void;
}

export function subscribeToEvents(handlers: EventHandlers): () => void {
  const eventSource = new EventSource(`${BASE}/events`);
  let wasConnected = false;

  eventSource.addEventListener("container-updated", (event) => {
    handlers.onContainerUpdated?.(JSON.parse(event.data) as ManagedContainer);
  });

  eventSource.addEventListener("container-removed", (event) => {
    const { id } = JSON.parse(event.data) as { id: string };
    handlers.onContainerRemoved?.(id);
  });

  eventSource.addEventListener("task-updated", (event) => {
    handlers.onTaskUpdated?.(JSON.parse(event.data) as Task);
  });

  eventSource.addEventListener("task-removed", (event) => {
    const { id } = JSON.parse(event.data) as { id: string };
    handlers.onTaskRemoved?.(id);
  });

  eventSource.onopen = () => {
    handlers.onConnectionError?.(true);
    if (wasConnected && handlers.onReconnect) {
      handlers.onReconnect();
    }
    wasConnected = true;
  };

  eventSource.onerror = () => {
    handlers.onConnectionError?.(false);
  };

  return () => eventSource.close();
}
