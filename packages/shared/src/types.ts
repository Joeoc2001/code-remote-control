import { z } from "zod";

export const gitConfigSchema = z.object({
  email: z.string(),
  username: z.string(),
});

export const environmentConfigSchema = z.object({
  name: z.string().min(1),
  opencode: z.record(z.string(), z.unknown()),
  env: z.record(z.string(), z.string()).optional(),
  git: gitConfigSchema,
});

export const environmentsFileSchema = z.object({
  configurations: z.array(environmentConfigSchema),
  iframeDomain: z.string().optional(),
});

export type GitConfig = z.infer<typeof gitConfigSchema>;
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;
export type EnvironmentsFile = z.infer<typeof environmentsFileSchema>;

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
  hostPort: number;
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
