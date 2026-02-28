export interface EnvironmentConfig {
  name: string;
  opencode: object;
  env?: Record<string, string>;
}

export interface EnvironmentsFile {
  configurations: EnvironmentConfig[];
}

export interface ContainerHealth {
  container: "running" | "stopped" | "error";
  openCode: "healthy" | "unhealthy" | "unknown";
}

export interface ManagedContainer {
  id: string;
  name: string;
  configName: string;
  repoName: string;
  status: string;
  health: ContainerHealth;
  remoteUrl: string | null;
  createdAt: string;
}

export interface CreateContainerRequest {
  configName: string;
  repoFullName: string;
}

export interface GitHubRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

export type SSEEvent =
  | { type: "container-updated"; data: ManagedContainer }
  | { type: "container-removed"; data: { id: string } };
