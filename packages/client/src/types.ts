export interface ContainerHealth {
  container: "running" | "stopped" | "error";
  claudeCode: "healthy" | "unhealthy" | "unknown";
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

export interface EnvironmentConfig {
  name: string;
  description: string;
  env: Record<string, string>;
}

export interface GitHubRepo {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}
